import pg from 'pg';
import { config } from '../config.js';
import { getRedisClient } from './redis.js';
import { randomBytes } from 'node:crypto';

const BASE_URL = 'https://console.neon.tech/api/v2';

// ── Caches ──────────────────────────────────────────────────
// Branch IDs are immutable per project — cache indefinitely.
const branchIdCache = new Map<string, string>();
// Roles that have been confirmed to exist on a project — skip list+check after first success.
const confirmedRoles = new Map<string, Set<string>>();
// Pooler host is project-level — cache once per project.
const poolerHostCache = new Map<string, string | null>();

interface NeonBranch {
  id: string;
  project_id: string;
  name: string;
  default: boolean;
}

interface NeonDatabase {
  id: number;
  branch_id: string;
  name: string;
  owner_name: string;
  created_at: string;
  updated_at: string;
}

/** Neon v2 may return only `{ uri }` or legacy `{ connection_uri, connection_parameters }`. */
function parseConnectionUriPayload(data: unknown): {
  connectionUri: string;
  poolerHost: string | undefined;
} {
  const d = data as Record<string, unknown>;
  const connectionUri =
    (typeof d.uri === 'string' && d.uri) ||
    (typeof d.connection_uri === 'string' && d.connection_uri) ||
    '';
  if (!connectionUri) {
    throw new Error(`Neon connection_uri response missing uri: ${JSON.stringify(data)}`);
  }
  const params = d.connection_parameters as Record<string, unknown> | undefined;
  const poolerHost =
    params && typeof params.pooler_host === 'string' ? params.pooler_host : undefined;
  return { connectionUri, poolerHost };
}

/**
 * Lua script for safe lock release — only delete if the value matches the caller's token.
 * Prevents releasing a lock that was already expired and re-acquired by another instance.
 */
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/**
 * Acquires a per-project Redis lock (mutex), executes `fn`, then releases.
 * Serializes Neon API mutations to avoid HTTP 423 ("conflicting operations")
 * when multiple instances create/delete databases on the same Neon project.
 *
 * A mutex (not semaphore) is intentional — zero 423 contention means each
 * operation finishes as fast as possible, maximizing queue throughput.
 *
 * If Redis is unavailable, falls through without the lock (Neon's own 423
 * retry in neonFetch acts as a safety net).
 */
export async function withNeonProjectLock<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = `lock:neon-project:${projectId}`;
  const token = randomBytes(8).toString('hex');
  const lockTtlSeconds = 120;
  const acquireTimeoutMs = 300_000; // 5 minutes — large batches need time to drain
  const pollBaseMs = 500;
  const jitterMs = 100;

  let redis: ReturnType<typeof getRedisClient>;
  try {
    redis = getRedisClient();
  } catch {
    return fn();
  }

  const start = Date.now();
  while (Date.now() - start < acquireTimeoutMs) {
    try {
      const acquired = await redis.set(lockKey, token, 'EX', lockTtlSeconds, 'NX');
      if (acquired === 'OK') {
        try {
          return await fn();
        } finally {
          try {
            await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token);
          } catch {
            // Best-effort release — TTL will clean up
          }
        }
      }
    } catch {
      // Redis error — fall through without lock
      return fn();
    }

    const jitter = Math.floor(Math.random() * jitterMs * 2) - jitterMs;
    await new Promise((resolve) => globalThis.setTimeout(resolve, pollBaseMs + jitter));
  }

  throw new Error(`Timed out waiting for Neon project lock (project=${projectId})`.replace(/(:\/\/[^:]*:)[^@]+(@)/g, '$1***$2'));
}

async function neonFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const maxAttempts = 6;
  const backoffMs = [500, 1000, 2000, 4000, 8000];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers: {
          'Authorization': `Bearer ${config.neon.apiKey}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
    } catch (err: unknown) {
      // Retry on network errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT, etc.)
      if (attempt < maxAttempts) {
        const delay = backoffMs[attempt - 1] ?? 8000;
        await new Promise((resolve) => globalThis.setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }

    // Retry on 423 (conflict / operation in progress) and 5xx (server errors)
    if ((res.status === 423 || res.status >= 500) && attempt < maxAttempts) {
      const delay = backoffMs[attempt - 1] ?? 8000;
      await new Promise((resolve) => globalThis.setTimeout(resolve, delay));
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      const errorMsg = `Neon API error ${res.status} ${path}: ${body}`;
      throw new Error(errorMsg.replace(/(:\/\/[^:]*:)[^@]+(@)/g, '$1***$2'));
    }

    return res;
  }

  const errorMsg = `Neon API error: max retries exceeded for ${path}`;
  throw new Error(errorMsg.replace(/(:\/\/[^:]*:)[^@]+(@)/g, '$1***$2'));
}

async function getDefaultBranchId(projectId: string): Promise<string> {
  const cached = branchIdCache.get(projectId);
  if (cached) return cached;

  const res = await neonFetch(`/projects/${projectId}/branches`);
  const data = await res.json() as { branches: NeonBranch[] };
  const defaultBranch = data.branches.find((b) => b.default);
  if (!defaultBranch) {
    throw new Error(`No default branch found for Neon project ${projectId}`.replace(/(:\/\/[^:]*:)[^@]+(@)/g, '$1***$2'));
  }
  branchIdCache.set(projectId, defaultBranch.id);
  return defaultBranch.id;
}

async function listRoleNames(projectId: string, branchId: string): Promise<string[]> {
  const res = await neonFetch(`/projects/${projectId}/branches/${branchId}/roles`);
  const data = await res.json() as { roles: { name: string }[] };
  return data.roles.map((r) => r.name);
}

/**
 * Neon requires database.owner_name to be an existing branch role. New projects often only
 * ship with e.g. neondb_owner — we create the configured owner if absent.
 */
export async function ensureRoleExists(projectId: string, roleName: string): Promise<void> {
  const roles = confirmedRoles.get(projectId);
  if (roles?.has(roleName)) return;

  const branchId = await getDefaultBranchId(projectId);
  let names = await listRoleNames(projectId, branchId);
  if (names.includes(roleName)) {
    // Cache all roles we saw so future checks are free
    if (!confirmedRoles.has(projectId)) confirmedRoles.set(projectId, new Set());
    for (const n of names) confirmedRoles.get(projectId)!.add(n);
    return;
  }

  const res = await fetch(`${BASE_URL}/projects/${projectId}/branches/${branchId}/roles`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.neon.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: { name: roleName } }),
  });

  if (res.ok) {
    if (!confirmedRoles.has(projectId)) confirmedRoles.set(projectId, new Set());
    confirmedRoles.get(projectId)!.add(roleName);
    return;
  }

  // Race: another provisioner or the console created the role after our list
  names = await listRoleNames(projectId, branchId);
  if (names.includes(roleName)) {
    if (!confirmedRoles.has(projectId)) confirmedRoles.set(projectId, new Set());
    confirmedRoles.get(projectId)!.add(roleName);
    return;
  }

  const text = await res.text();
  const errorMsg = `Neon API error ${res.status} /projects/${projectId}/branches/${branchId}/roles: ${text}`;
  throw new Error(errorMsg.replace(/(:\/\/[^:]*:)[^@]+(@)/g, '$1***$2'));
}

export async function createDatabase(
  projectId: string,
  dbName: string,
  ownerName: string
): Promise<NeonDatabase | null> {
  const branchId = await getDefaultBranchId(projectId);

  let data: { database: NeonDatabase } | null = null;
  try {
    const res = await neonFetch(`/projects/${projectId}/branches/${branchId}/databases`, {
      method: 'POST',
      body: JSON.stringify({
        database: { name: dbName, owner_name: ownerName },
      }),
    });
    data = await res.json() as { database: NeonDatabase };
  } catch (err) {
    // Idempotency: a prior provisioning attempt may have created the DB on
    // Neon but failed downstream (grantSchemaPrivileges, migrations, etc.),
    // leaving apps.provisioning_status='failed' and the dest app stuck. The
    // retry-resume path calls us again with the same dbName; Neon answers
    // 409 DATABASE_ALREADY_EXISTS. Treat that as success and fall through
    // to waitUntilQueryable — the DB is already there, we just need to
    // confirm it's reachable.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('DATABASE_ALREADY_EXISTS') || /Neon API error 409\b/.test(msg)) {
      // data stays null; caller can't depend on the freshly-created row.
    } else {
      throw err;
    }
  }

  // Block until the new DB actually answers a SELECT 1. Neon's REST API
  // returns 200 once the control-plane has accepted the database, but the
  // data-plane endpoint can take a few seconds to propagate. Without this
  // wait, the very next caller (grantSchemaPrivileges, runMigrations, etc.)
  // races against propagation and surfaces a Postgres 3D000 "database does
  // not exist" error. Centralizing the readiness check here means downstream
  // code can assume the DB is queryable the moment createDatabase returns.
  await waitUntilQueryable(projectId, dbName, ownerName);

  return data?.database ?? null;
}

// ---------------------------------------------------------------------------
// Neon DB readiness probe
// ---------------------------------------------------------------------------

/** Postgres/connection error codes that indicate Neon is still propagating
 *  or the compute is mid-cold-start — safe to retry against. Anything else
 *  is a real error and should bubble up immediately. */
const READINESS_RETRYABLE_CODES = new Set<string>([
  '3D000',           // database does not exist yet (async create still in progress)
  '08006', '08001',  // connection failure / unable to establish
  '57P01',           // admin shutdown (compute restart)
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
]);

const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const DEFAULT_READINESS_BACKOFFS_MS = [200, 500, 1000, 2000, 4000, 8000];

export interface WaitOptions {
  /** Connection probe — replaceable for unit tests. Production uses a real
   *  pg.Pool. The probe should resolve on success and throw a `pg`-shaped
   *  Error (with a `.code` property) on retryable failure. */
  probe?: (connectionUri: string) => Promise<void>;
  timeoutMs?: number;
  backoffsMs?: number[];
}

async function defaultProbe(connectionUri: string): Promise<void> {
  const pool = new pg.Pool({
    connectionString: connectionUri,
    max: 1,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5_000,
  });
  try {
    await pool.query('SELECT 1');
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Public entry point: resolve a connection string for the new DB and block
 * until it accepts a trivial query. Throws on overall timeout — at that
 * point it's not a race, it's a Neon incident and should page someone.
 */
export async function waitUntilQueryable(
  projectId: string,
  dbName: string,
  ownerName: string,
  opts: WaitOptions = {},
): Promise<void> {
  const { connectionUri } = await getConnectionString(projectId, dbName, ownerName);
  await waitUntilUriQueryable(connectionUri, dbName, opts);
}

/**
 * Inner: retry-with-backoff a probe against a known connection string.
 * Exported so unit tests can drive the loop with a stubbed probe without
 * also having to mock the Neon REST API behind getConnectionString.
 */
export async function waitUntilUriQueryable(
  connectionUri: string,
  dbName: string,
  opts: WaitOptions = {},
): Promise<void> {
  const probe = opts.probe ?? defaultProbe;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const backoffsMs = opts.backoffsMs ?? DEFAULT_READINESS_BACKOFFS_MS;
  const start = Date.now();
  let attempt = 0;
  while (true) {
    try {
      await probe(connectionUri);
      return;
    } catch (err) {
      const code = err instanceof Error && 'code' in err
        ? (err as { code: string }).code
        : undefined;
      if (!code || !READINESS_RETRYABLE_CODES.has(code)) throw err;
      if (Date.now() - start >= timeoutMs) {
        throw new Error(
          `Neon database "${dbName}" not queryable after ${timeoutMs}ms ` +
          `(last code: ${code}); likely a Neon control-plane → data-plane ` +
          `propagation incident.`,
        );
      }
      const delay = backoffsMs[Math.min(attempt, backoffsMs.length - 1)];
      await new Promise((resolve) => globalThis.setTimeout(resolve, delay));
      attempt++;
    }
  }
}

export async function deleteDatabase(
  projectId: string,
  dbName: string
): Promise<void> {
  const branchId = await getDefaultBranchId(projectId);
  await neonFetch(`/projects/${projectId}/branches/${branchId}/databases/${dbName}`, {
    method: 'DELETE',
  });
}

export interface NeonDatabaseSummary {
  name: string;
  createdAt: string;
}

/**
 * List every database on the project's default branch. Used by the orphan
 * reconciler to enumerate the full Neon inventory and diff it against
 * `runtimeDb.apps`. Returns bare `{ name, createdAt }` — callers should not
 * depend on the raw Neon response shape.
 */
export async function listDatabases(projectId: string): Promise<NeonDatabaseSummary[]> {
  const branchId = await getDefaultBranchId(projectId);
  const res = await neonFetch(`/projects/${projectId}/branches/${branchId}/databases`);
  const data = await res.json() as { databases: NeonDatabase[] };
  return data.databases.map((db) => ({ name: db.name, createdAt: db.created_at }));
}

/**
 * After creating a DB on Neon (PG 15+), the `public` schema CREATE privilege
 * is revoked by default.  Connect as the project owner (`neondb_owner`) and
 * grant CREATE + USAGE to the application role so migrations can run.
 */
export async function grantSchemaPrivileges(
  projectId: string,
  dbName: string,
  targetRole: string,
): Promise<void> {
  // Get a connection string as neondb_owner (project-level superuser)
  const { connectionUri } = await getConnectionString(projectId, dbName, 'neondb_owner');

  const pool = new pg.Pool({
    connectionString: connectionUri,
    max: 1,
    ssl: { rejectUnauthorized: false },
  });
  try {
    // escapeIdentifier is available on Client instances; create one to use it safely
    const client = await pool.connect();
    try {
      await client.query(`GRANT ALL ON SCHEMA public TO ${client.escapeIdentifier(targetRole)}`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function getConnectionString(
  projectId: string,
  dbName: string,
  roleName: string
): Promise<{
  connectionUri: string;
  poolerHost: string | undefined;
  /** Full pooled connection string from Neon when `pooled=true` returns a URI */
  pooledConnectionUri: string | undefined;
}> {
  const params = new URLSearchParams({
    database_name: dbName,
    role_name: roleName,
  });

  const res = await neonFetch(`/projects/${projectId}/connection_uri?${params}`);
  const direct = parseConnectionUriPayload(await res.json());

  // Cache pooler host on first discovery — it's project-level, not DB-level
  if (direct.poolerHost && !poolerHostCache.has(projectId)) {
    poolerHostCache.set(projectId, direct.poolerHost);
  }

  let pooledConnectionUri: string | undefined;
  const cachedPoolerHost = direct.poolerHost ?? poolerHostCache.get(projectId);

  if (cachedPoolerHost) {
    // Build pooled URI from cached pooler host — skip the extra API call
    const url = new URL(direct.connectionUri);
    url.hostname = cachedPoolerHost;
    url.port = '6543';
    pooledConnectionUri = url.toString();
  } else {
    // No pooler host known yet — fetch via pooled=true endpoint
    try {
      const pooledParams = new URLSearchParams(params);
      pooledParams.set('pooled', 'true');
      const resPooled = await neonFetch(
        `/projects/${projectId}/connection_uri?${pooledParams}`
      );
      const pooled = parseConnectionUriPayload(await resPooled.json());
      if (pooled.connectionUri && pooled.connectionUri !== direct.connectionUri) {
        pooledConnectionUri = pooled.connectionUri;
        // Extract and cache the pooler host for future calls
        try {
          const pooledUrl = new URL(pooled.connectionUri);
          poolerHostCache.set(projectId, pooledUrl.hostname);
        } catch { /* best effort */ }
      }
    } catch {
      // Pooler optional; direct URI still works
    }
  }

  return {
    connectionUri: direct.connectionUri,
    poolerHost: cachedPoolerHost ?? undefined,
    pooledConnectionUri,
  };
}
