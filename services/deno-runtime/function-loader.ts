// Function metadata loader with LRU cache
import { Pool, type PoolClient } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
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
  /**
   * Per-app function key for ctx.kv and ctx.integrations. NOT placed in
   * env_vars on purpose: env_vars is exposed to user code via ctx.env, and
   * a user who console.logs(ctx.env) (or ships it to a third-party logger)
   * would leak the key. The worker template reads this field directly to
   * mint the Authorization header for KV and integration calls.
   */
  internal_fn_key: string | null;
  timeout_ms: number;
  memory_limit_mb: number;
  /**
   * Per-function gate for service-key impersonation (Phase 2). When false,
   * the control-api edge will 403 any call carrying `X-Butterbase-As-User`
   * before the function runs. Default true preserves the implicit pre-Phase-2
   * contract (bearer-equality check was implicitly allowing this for any
   * app-scoped key) — flip to false in `manage_function` for admin-only or
   * billing-webhook handlers that should never accept an as-user assertion.
   */
  allow_service_key_impersonation: boolean;
  db_connection_string: string | null;
  /**
   * Non-null when the app is linked to an org substrate — worker-executor
   * uses this as the gate for injecting ctx.substrate. Replaces the legacy
   * substrate_user_id gate that was dropped with runtime migration 042.
   */
  substrate_organization_id: string | null;
  /**
   * Platform-known values surfaced to user code via ctx.env.BUTTERBASE_*
   * and the structured ctx.app mirror. Strictly platform-owned, non-secret
   * values pulled from the apps row. Any field may be null when not
   * configured — the worker template omits absent flat keys and mirrors
   * null on ctx.app so user code can branch with `if (ctx.app.frontend)`.
   */
  platform: {
    app_name: string;
    owner_id: string;
    region: string;
    subdomain: string | null;
    frontend_url: string | null;
    anon_key: string;
    allowed_origins: string[];
    stripe_connect_account_id: string | null;
    ai_default_model: string | null;
    jwt_access_token_ttl: string | null;
    jwt_refresh_token_ttl_days: number | null;
    auth_hook_function: string | null;
  };
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

// Neon's pooler silently drops idle TCP sessions (~5 min). A client checked out
// from runtimePool can hold a dead socket whose first write fails with
// BrokenPipe / EPIPE / ConnectionAborted. Detect that surface so withRuntimeClient
// can drop the poisoned client and retry once on a fresh connection instead of
// surfacing a 500 to the caller.
//
// Exported for invocation-logger.ts (which keeps a separate loggingPool against
// the same runtime DB and has the same idle-eviction problem).
export function isDeadConnectionError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string; code?: string; cause?: unknown };
  if (e.name === "BrokenPipe" || e.name === "ConnectionReset" || e.name === "ConnectionAborted") return true;
  if (e.code === "EPIPE" || e.code === "ECONNRESET" || e.code === "ECONNABORTED") return true;
  const msg = String(e.message ?? "").toLowerCase();
  if (
    msg.includes("broken pipe") ||
    msg.includes("connection reset") ||
    msg.includes("connection refused") ||
    msg.includes("connection closed") ||
    msg.includes("connection is closed") ||
    msg.includes("unexpected eof") ||
    msg.includes("not connected") ||
    // deno-postgres surface when the backend sent a FATAL terminate notice
    // (e.g. Neon idle eviction reaping the session, or admin-initiated
    // pg_terminate_backend). Same operational meaning as BrokenPipe — the
    // pooled client is unusable and must be dropped before retry.
    msg.includes("session was terminated") ||
    msg.includes("terminating connection")
  ) return true;
  return e.cause ? isDeadConnectionError(e.cause) : false;
}

// Drop a poisoned client without returning it to the pool. deno-postgres'
// PoolClient.release() puts the connection back on the free list — if the
// underlying TCP is dead, the next caller picks up the same broken socket.
// end() closes the connection (mirrors the safeCommit pattern in
// worker-executor.ts); release() is then a best-effort cleanup of the pool slot.
async function dropClient(client: PoolClient): Promise<void> {
  try { await (client as unknown as { end?: () => Promise<void> }).end?.(); } catch { /* ignore */ }
  try { client.release(); } catch { /* ignore */ }
}

// Acquire → run → release helper that retries once on a dead connection.
// The callback must be safe to re-run (all runtimePool callers here are
// read-only metadata lookups, so idempotency is trivially satisfied).
async function withRuntimeClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const client = await runtimePool.connect();
    try {
      const result = await fn(client);
      client.release();
      return result;
    } catch (err) {
      await dropClient(client);
      if (attempt === 1 || !isDeadConnectionError(err)) throw err;
      console.warn(
        `[function-loader] runtimePool dead connection (${(err as Error).message ?? err}); retrying once`,
      );
    }
  }
  // Unreachable: loop either returns or throws on each iteration.
  throw new Error("withRuntimeClient: exhausted retries");
}

/**
 * Prove the runtime DB pool can serve queries before we let Fly's health
 * check pass. Without this, a fresh machine starts listening on /health
 * (returning 200 immediately) while runtimePool.connect() is still doing
 * its first TCP + TLS + auth roundtrip; a cron dispatch that lands in
 * that window sees an empty result for `SELECT ... FROM app_functions`
 * and 404s "Function not found". Cost: one round-trip on boot, ~50ms.
 * Retries with backoff so a slow Neon cold-start doesn't kill the
 * machine — Fly will restart us anyway after grace_period expires.
 */
export async function warmupRuntimePool(): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await withRuntimeClient(async (client) => {
        await client.queryObject("SELECT 1");
      });
      console.log(`[function-loader] runtime pool warm (${Date.now() - start}ms, attempt ${attempt + 1})`);
      return;
    } catch (err) {
      lastErr = err;
      const backoffMs = 500 * (attempt + 1);
      console.warn(
        `[function-loader] warmup attempt ${attempt + 1} failed: ${(err as Error).message}; retrying in ${backoffMs}ms`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw new Error(
    `runtime pool warmup failed after 5 attempts: ${(lastErr as Error)?.message ?? lastErr}`,
  );
}

function getCacheKey(appId: string, functionName: string): string {
  return `${appId}:${functionName}`;
}

async function getDeployedAt(
  appId: string,
  functionName: string
): Promise<Date | null> {
  return withRuntimeClient(async (client) => {
    const result = await client.queryObject(
      `SELECT deployed_at FROM app_functions
       WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [appId, functionName]
    );
    return result.rows.length > 0 ? (result.rows[0] as any).deployed_at : null;
  });
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

  // Load from database. withRuntimeClient retries once on a dead pooled
  // connection (BrokenPipe from Neon's idle-socket eviction) so a stale slot
  // doesn't surface as a 500 to the function caller.
  return withRuntimeClient(async (client): Promise<FunctionMetadata | null> => {
    const result = await client.queryObject(
      `SELECT
        f.id, f.app_id, f.name, f.code, f.encrypted_env_vars,
        f.timeout_ms, f.memory_limit_mb,
        f.allow_service_key_impersonation,
        f.deployed_at,
        a.encrypted_env_vars AS app_encrypted_env_vars
       FROM app_functions f
       LEFT JOIN app_env_vars a ON a.app_id = f.app_id
       WHERE f.app_id = $1 AND f.name = $2 AND f.deleted_at IS NULL`,
      [appId, functionName]
    );

    if (result.rows.length === 0) {
      console.log(`Function not found: ${cacheKey}`);
      return null;
    }

    const row = result.rows[0] as any;

    // Check if app database is provisioned + pull platform-known values
    // surfaced to user code via ctx.env.BUTTERBASE_* / ctx.app.
    const appCheck = await client.queryObject(
      `SELECT
         db_provisioned, substrate_organization_id,
         name, owner_id, region, subdomain,
         deployment_url, anon_key, allowed_origins,
         stripe_connect_account_id,
         ai_config, jwt_config, auth_hook_function
       FROM apps WHERE id = $1`,
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

    // Merge: app-level vars first, then per-function vars override. Platform
    // BUTTERBASE_* vars are spread AFTER this in worker-executor.ts and always win.
    const appEnv      = decryptEnvVars(row.app_encrypted_env_vars, ENCRYPTION_KEY);
    const functionEnv = decryptEnvVars(row.encrypted_env_vars,     ENCRYPTION_KEY);
    const envVars = { ...appEnv, ...functionEnv };

    // Fetch the per-app function key so ctx.kv and ctx.integrations can
    // authenticate against the gateway. Stored on metadata.internal_fn_key
    // — NOT injected into env_vars, because env_vars is exposed via ctx.env
    // and a user who logs ctx.env would leak the key. Failure is non-fatal:
    // ctx.kv / ctx.integrations calls will fail later with an auth error.
    const kvKey = await fetchKvFunctionKey(appId);

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

    const aiConfig = (app.ai_config ?? {}) as Record<string, unknown>;
    const jwtConfig = (app.jwt_config ?? {}) as Record<string, unknown>;

    const metadata: FunctionMetadata = {
      id: row.id,
      app_id: row.app_id,
      function_name: row.name,
      code: row.code,
      env_vars: envVars,
      internal_fn_key: kvKey,
      timeout_ms: row.timeout_ms,
      memory_limit_mb: row.memory_limit_mb,
      allow_service_key_impersonation: row.allow_service_key_impersonation !== false,
      db_connection_string: dbConnectionString,
      substrate_organization_id: app.substrate_organization_id ?? null,
      platform: {
        app_name: app.name,
        owner_id: app.owner_id,
        region: app.region,
        subdomain: app.subdomain ?? null,
        frontend_url: app.deployment_url ?? null,
        anon_key: app.anon_key,
        allowed_origins: Array.isArray(app.allowed_origins) ? app.allowed_origins : [],
        stripe_connect_account_id: app.stripe_connect_account_id ?? null,
        ai_default_model: typeof aiConfig.defaultModel === 'string' ? aiConfig.defaultModel : null,
        jwt_access_token_ttl: typeof jwtConfig.accessTokenTtl === 'string' ? jwtConfig.accessTokenTtl : null,
        jwt_refresh_token_ttl_days: typeof jwtConfig.refreshTokenTtlDays === 'number' ? jwtConfig.refreshTokenTtlDays : null,
        auth_hook_function: app.auth_hook_function ?? null,
      },
    };

    // Add to cache (LRU eviction if full)
    if (cache.size >= MAX_CACHE_SIZE) {
      const firstKey = cache.keys().next().value as string | undefined;
      if (firstKey !== undefined) cache.delete(firstKey);
    }

    cache.set(cacheKey, {
      metadata,
      expires: Date.now() + CACHE_TTL_MS,
      deployed_at: row.deployed_at,
    });

    return metadata;
  });
}

export function invalidateCache(appId: string, functionName: string): void {
  const cacheKey = getCacheKey(appId, functionName);
  cache.delete(cacheKey);
  console.log(`Cache invalidated: ${cacheKey}`);
}
