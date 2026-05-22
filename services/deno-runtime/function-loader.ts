// Function metadata loader with LRU cache
import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { decryptEnvVars } from "./crypto.ts";

// Multi-region: resolve instance region from BUTTERBASE_REGION (explicit)
// or FLY_REGION + BUTTERBASE_FLY_REGION_MAP (derivation, mirrors
// @butterbase/shared loadRegionConfig). Then pick the regional runtime DB.
function resolveInstanceRegion(): string | null {
  const explicit = Deno.env.get("BUTTERBASE_REGION");
  if (explicit) return explicit;
  const fly = Deno.env.get("FLY_REGION");
  const map = Deno.env.get("BUTTERBASE_FLY_REGION_MAP");
  if (fly && map) {
    for (const pair of map.split(",")) {
      const [k, v] = pair.split(":").map((s) => s.trim());
      if (k === fly && v) return v;
    }
  }
  return null;
}

function getRuntimeDbUrl(): string {
  const region = resolveInstanceRegion();
  if (region) {
    const suffix = region.toUpperCase().replace(/-/g, "_");
    const envKey = `NEON_RUNTIME_PROJECT_ID_${suffix}`;
    const url = Deno.env.get(envKey);
    if (url) return url;
    console.warn(
      `[function-loader] ${envKey} not set; falling back to CONTROL_PLANE_URL`,
    );
  } else {
    console.warn(
      `[function-loader] could not resolve region from BUTTERBASE_REGION or FLY_REGION+BUTTERBASE_FLY_REGION_MAP; falling back to CONTROL_PLANE_URL`,
    );
  }
  // Fallback: legacy env var (single-region pre-Phase-2 deployments)
  const fallback = Deno.env.get("CONTROL_PLANE_URL");
  if (!fallback) {
    throw new Error(
      "Runtime DB URL not configured: set BUTTERBASE_REGION (or FLY_REGION + " +
        "BUTTERBASE_FLY_REGION_MAP) + NEON_RUNTIME_PROJECT_ID_<REGION>, or CONTROL_PLANE_URL (legacy)",
    );
  }
  return fallback;
}

const ENCRYPTION_KEY = Deno.env.get("AUTH_ENCRYPTION_KEY")!;

async function fetchKvFunctionKey(appId: string): Promise<string | null> {
  const base = Deno.env.get('CONTROL_API_URL');
  const secret = Deno.env.get('BUTTERBASE_INTERNAL_SECRET');
  if (!base || !secret) return null;
  try {
    const res = await fetch(`${base}/v1/internal/kv/function-credentials/${appId}`, {
      headers: { 'x-butterbase-internal-secret': secret },
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.kv_function_key ?? null;
  } catch (err) {
    console.warn('[function-loader] failed to fetch kv_function_key', err);
    return null;
  }
}
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 1000;

export interface FunctionMetadata {
  id: string;
  app_id: string;
  function_name: string;
  code: string;
  env_vars: Record<string, string>;
  timeout_ms: number;
  memory_limit_mb: number;
  trigger_type: string;
  trigger_config: any;
  db_connection_string: string | null;
}

interface CacheEntry {
  metadata: FunctionMetadata;
  expires: number;
  deployed_at: Date;
}

// LRU Cache
const cache = new Map<string, CacheEntry>();

// Connection pool to the runtime DB (app_functions, apps, app_db_connections)
const runtimePool = new Pool(getRuntimeDbUrl(), 10);

function getCacheKey(appId: string, functionName: string): string {
  return `${appId}:${functionName}`;
}

async function getDeployedAt(
  appId: string,
  functionName: string
): Promise<Date | null> {
  const client = await runtimePool.connect();
  try {
    const result = await client.queryObject(
      `SELECT deployed_at FROM app_functions
       WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [appId, functionName]
    );
    return result.rows.length > 0 ? (result.rows[0] as any).deployed_at : null;
  } finally {
    client.release();
  }
}

export async function loadFunction(
  appId: string,
  functionName: string
): Promise<FunctionMetadata | null> {
  const cacheKey = getCacheKey(appId, functionName);

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expires) {
    // Verify cached version is current
    const currentDeployedAt = await getDeployedAt(appId, functionName);

    if (currentDeployedAt === null) {
      cache.delete(cacheKey);
      console.log(`Function deleted: ${cacheKey}`);
      return null;
    }

    if (currentDeployedAt.getTime() <= cached.deployed_at.getTime()) {
      console.log(`Cache hit (verified): ${cacheKey}`);
      return cached.metadata;
    }

    console.log(`Cache stale (deployed_at mismatch): ${cacheKey}`);
    cache.delete(cacheKey);
  }

  console.log(`Cache miss: ${cacheKey}, loading from DB...`);

  // Load from database
  const client = await runtimePool.connect();
  try {
    const result = await client.queryObject(
      `SELECT
        id, app_id, name, code, encrypted_env_vars,
        timeout_ms, memory_limit_mb, trigger_type, trigger_config,
        deployed_at
       FROM app_functions
       WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [appId, functionName]
    );

    if (result.rows.length === 0) {
      console.log(`Function not found: ${cacheKey}`);
      return null;
    }

    const row = result.rows[0] as any;

    // Check if app database is provisioned
    const appCheck = await client.queryObject(
      `SELECT db_provisioned FROM apps WHERE id = $1`,
      [appId]
    );

    if (appCheck.rows.length === 0) {
      console.log(`App not found: ${appId}`);
      return null;
    }

    const app = appCheck.rows[0] as any;
    if (!app.db_provisioned) {
      console.log(`App database not provisioned: ${appId}`);
      throw new Error(
        `Database not provisioned for app ${appId}. The app is still being set up. ` +
        `Wait a few seconds and try again, or check the app status with list_apps.`
      );
    }

    // Decrypt environment variables
    const envVars = decryptEnvVars(row.encrypted_env_vars, ENCRYPTION_KEY);

    // Inject per-app KV function key so ctx.kv calls authenticate via the gateway.
    // Failure is non-fatal: only ctx.kv calls will fail later with an auth error.
    const kvKey = await fetchKvFunctionKey(appId);
    if (kvKey) envVars.BUTTERBASE_FUNCTION_SERVICE_KEY = kvKey;

    // Fetch database connection string for this app
    const connResult = await client.queryObject<{ connection_string: string }>(
      `SELECT connection_string FROM app_db_connections WHERE app_id = $1`,
      [appId]
    );

    if (connResult.rows.length === 0) {
      console.log(`No database connection string for app: ${appId}`);
      throw new Error(
        `Database connection not configured for app ${appId}. ` +
        `The app may still be provisioning. Wait a few seconds and try again.`
      );
    }

    const dbConnectionString = connResult.rows[0].connection_string;

    const metadata: FunctionMetadata = {
      id: row.id,
      app_id: row.app_id,
      function_name: row.name,
      code: row.code,
      env_vars: envVars,
      timeout_ms: row.timeout_ms,
      memory_limit_mb: row.memory_limit_mb,
      trigger_type: row.trigger_type,
      trigger_config: row.trigger_config,
      db_connection_string: dbConnectionString,
    };

    // Add to cache (LRU eviction if full)
    if (cache.size >= MAX_CACHE_SIZE) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }

    cache.set(cacheKey, {
      metadata,
      expires: Date.now() + CACHE_TTL_MS,
      deployed_at: row.deployed_at,
    });

    return metadata;
  } finally {
    client.release();
  }
}

export function invalidateCache(appId: string, functionName: string): void {
  const cacheKey = getCacheKey(appId, functionName);
  cache.delete(cacheKey);
  console.log(`Cache invalidated: ${cacheKey}`);
}
