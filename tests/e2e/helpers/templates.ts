/**
 * Shared helpers for app-template clone e2e tests (A1-A7 + security tests).
 *
 * Modeled after the inline helpers in 22-app-clone.test.ts and
 * 23-app-templates-discovery.test.ts. Import these instead of duplicating
 * per-file.
 */

import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

export const API_URL = 'http://localhost:4000';
export const CONTROL_DB_URL = 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
export const RUNTIME_DB_URL_US = 'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';
export const RUNTIME_DB_URL_EU = 'postgresql://butterbase:butterbase_dev@localhost:5438/butterbase_runtime_eu';
// Local data-plane DB (us-east-1 / only region in local dev): port 5435.
export const DATA_PLANE_DB_ADMIN_URL = 'postgresql://butterbase:butterbase_dev@localhost:5435/postgres';

/** Map of region → local runtime DB connection string (for local dev only). */
const RUNTIME_DB_URLS_BY_REGION: Record<string, string> = {
  'us-east-1': RUNTIME_DB_URL_US,
  'eu-west-1': RUNTIME_DB_URL_EU,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeededUser {
  userId: string;
  apiKey: string;
}

export interface SeededApp {
  userId: string;
  appId: string;
  apiKey: string;
}

export interface CloneJobStatusRes {
  job_id: string;
  /** The job status values exposed by GET /v1/clone-jobs/:id. */
  status: string;
  source_app_id: string;
  dest_app_id: string | null;
  retry_count: number;
  error_message: string | null;
}

// ---------------------------------------------------------------------------
// Internal key-generation
// ---------------------------------------------------------------------------

function generateApiKey(): { fullKey: string; keyHash: string; keyPrefix: string } {
  const fullKey = `bb_sk_${randomBytes(20).toString('hex')}`;
  const keyHash = createHash('sha256').update(fullKey).digest('hex');
  return { fullKey, keyHash, keyPrefix: fullKey.substring(0, 12) };
}

// ---------------------------------------------------------------------------
// seedUserAndApp
// ---------------------------------------------------------------------------

/**
 * Creates a platform_user + api_key + app row in the given region.
 * Returns `{ userId, apiKey, appId }`.
 */
export async function seedUserAndApp(
  controlPool: pg.Pool,
  runtimePool: pg.Pool,
  region: string,
  prefix = 'tmpl-e2e',
): Promise<SeededApp> {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${stamp}@example.com`;

  const u = await controlPool.query<{ id: string }>(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES (gen_random_uuid(), $1, 'active', 'launch') RETURNING id`,
    [email],
  );
  const userId = u.rows[0].id;

  const { fullKey, keyHash, keyPrefix } = generateApiKey();
  await controlPool.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name, scopes, scope, substrate_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, keyHash, keyPrefix, `${prefix}-key`, ['*'], 'app', null],
  );

  const appId = `${prefix}-app-${stamp}`;
  const subdomain = `${prefix}-${stamp}`;

  await controlPool.query(
    `INSERT INTO user_app_index (app_id, user_id, region) VALUES ($1, $2, $3)`,
    [appId, userId, region],
  );
  await runtimePool.query(
    `INSERT INTO apps (id, name, owner_id, db_name, subdomain, region, provisioning_status, db_provisioned)
     VALUES ($1, $2, $3, $4, $5, $6, 'ready', true)`,
    [appId, `${prefix} ${stamp}`, userId, `cust_${appId.replace(/-/g, '_')}`, subdomain, region],
  );

  return { userId, appId, apiKey: fullKey };
}

// ---------------------------------------------------------------------------
// applySchemaAsOwner
// ---------------------------------------------------------------------------

/**
 * POSTs the given schema DSL to `POST /v1/:appId/schema/apply` as the app's
 * owner. Throws if the response is not 200.
 */
export async function applySchemaAsOwner(
  apiKey: string,
  appId: string,
  dsl: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${API_URL}/v1/${appId}/schema/apply`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ schema: dsl }),
  });
  if (!res.ok) {
    throw new Error(`applySchemaAsOwner failed: ${res.status} ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// startCloneJob
// ---------------------------------------------------------------------------

export interface CloneJobCreated {
  jobId: string;
}

/**
 * Calls `POST /v1/templates/:sourceAppId/clone` and returns `{ jobId }`.
 * The clone POST response returns `{ job_id, status }` only — `dest_app_id`
 * is assigned by the worker later and can be retrieved via `waitForCloneStep`.
 *
 * Throws if the HTTP response is not 200.
 */
export async function startCloneJob(
  apiKey: string,
  sourceAppId: string,
  destName?: string,
  destRegion?: string,
): Promise<CloneJobCreated> {
  const body: Record<string, string> = {};
  if (destName) body.name = destName;
  if (destRegion) body.dest_region = destRegion;

  const res = await fetch(`${API_URL}/v1/templates/${sourceAppId}/clone`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`startCloneJob failed: ${res.status} ${await res.text()}`);
  }
  const j = await res.json() as { job_id: string; status: string };
  return { jobId: j.job_id };
}

// ---------------------------------------------------------------------------
// waitForCloneStep
// ---------------------------------------------------------------------------

/**
 * Polls `GET /v1/clone-jobs/:jobId` until the job reaches one of the given
 * terminal statuses (or throws on timeout).
 */
export async function waitForCloneStep(
  apiKey: string,
  jobId: string,
  terminalStatuses: string[],
  timeoutMs: number,
): Promise<CloneJobStatusRes> {
  const start = Date.now();
  let last: CloneJobStatusRes | undefined;

  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${API_URL}/v1/clone-jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) throw new Error(`waitForCloneStep GET failed: ${r.status} ${await r.text()}`);
    last = await r.json() as CloneJobStatusRes;
    if (terminalStatuses.includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(
    `Job ${jobId} did not reach [${terminalStatuses.join('|')}] within ${timeoutMs}ms ` +
    `(last=${JSON.stringify(last)})`,
  );
}

// ---------------------------------------------------------------------------
// waitForProvisioning
// ---------------------------------------------------------------------------

/**
 * Polls `GET /apps/:appId/status` until `provisioning_status` is 'ready'.
 * Throws on 'failed' or timeout.
 */
export async function waitForProvisioning(
  apiKey: string,
  appId: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${API_URL}/apps/${appId}/status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (r.ok) {
      const body = await r.json() as { provisioning_status?: string };
      if (body.provisioning_status === 'ready') return;
      if (body.provisioning_status === 'failed') {
        throw new Error(`App ${appId} provisioning failed`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`App ${appId} provisioning timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// pushSnapshot — minimal snapshot to satisfy clone pre-condition
// ---------------------------------------------------------------------------

/**
 * Pushes a single-file snapshot for an app (prepare → blob upload → commit).
 * Returns the snapshot_id assigned by the server.
 */
export async function pushSnapshot(
  apiKey: string,
  appId: string,
  fileBody: string,
): Promise<string> {
  const sha256 = createHash('sha256').update(fileBody).digest('hex');
  const size = Buffer.byteLength(fileBody, 'utf8');
  const manifestBody = { files: [{ path: 'README.md', sha256, size }] };

  const prep = await fetch(`${API_URL}/v1/${appId}/repo/snapshots/prepare`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(manifestBody),
  });
  if (!prep.ok) throw new Error(`pushSnapshot prepare failed: ${prep.status} ${await prep.text()}`);
  const pj = await prep.json() as {
    snapshot_id: string;
    missing_blobs: { sha256: string; uploadUrl: string }[];
  };

  for (const mb of pj.missing_blobs) {
    const put = await fetch(mb.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: fileBody,
    });
    if (!put.ok) throw new Error(`pushSnapshot blob upload failed: ${put.status} ${await put.text()}`);
  }

  const commit = await fetch(`${API_URL}/v1/${appId}/repo/snapshots/commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: manifestBody }),
  });
  if (!commit.ok) throw new Error(`pushSnapshot commit failed: ${commit.status} ${await commit.text()}`);
  const cj = await commit.json() as { snapshot_id: string };
  return cj.snapshot_id;
}

// ---------------------------------------------------------------------------
// pushFileSnapshot — push a snapshot with a specific file path
// ---------------------------------------------------------------------------

/**
 * Like pushSnapshot but uses a caller-supplied file path instead of 'README.md'.
 * Returns the snapshot_id assigned by the server.
 *
 * Useful for tests that need to verify a specific file's sha256 in the manifest
 * (e.g. proving a pinned snapshot contains 'a.txt' with known content).
 */
export async function pushFileSnapshot(
  apiKey: string,
  appId: string,
  filePath: string,
  fileBody: string,
): Promise<string> {
  const sha256 = createHash('sha256').update(fileBody).digest('hex');
  const size = Buffer.byteLength(fileBody, 'utf8');
  const manifestBody = { files: [{ path: filePath, sha256, size }] };

  const prep = await fetch(`${API_URL}/v1/${appId}/repo/snapshots/prepare`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(manifestBody),
  });
  if (!prep.ok) throw new Error(`pushFileSnapshot prepare failed: ${prep.status} ${await prep.text()}`);
  const pj = await prep.json() as {
    snapshot_id: string;
    missing_blobs: { sha256: string; uploadUrl: string }[];
  };

  for (const mb of pj.missing_blobs) {
    const put = await fetch(mb.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: fileBody,
    });
    if (!put.ok) throw new Error(`pushFileSnapshot blob upload failed: ${put.status} ${await put.text()}`);
  }

  const commit = await fetch(`${API_URL}/v1/${appId}/repo/snapshots/commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: manifestBody }),
  });
  if (!commit.ok) throw new Error(`pushFileSnapshot commit failed: ${commit.status} ${await commit.text()}`);
  const cj = await commit.json() as { snapshot_id: string };
  return cj.snapshot_id;
}

// ---------------------------------------------------------------------------
// insertRowsAsOwner — POST rows via the auto-API as the app owner
// ---------------------------------------------------------------------------

/**
 * Inserts one or more rows into `table` via `POST /v1/:appId/:table`.
 * Each row object is sent as a separate request (the auto-API accepts one
 * object per call). Throws if any request is not 200/201.
 */
export async function insertRowsAsOwner(
  apiKey: string,
  appId: string,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  for (const row of rows) {
    const res = await fetch(`${API_URL}/v1/${appId}/${table}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      throw new Error(
        `insertRowsAsOwner failed on table "${table}": ${res.status} ${await res.text()}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// queryAppDb — run a query directly against a per-app database (local dev only)
// ---------------------------------------------------------------------------
// queryRuntimeDb — run a query directly against a region's runtime DB (local dev only)
// ---------------------------------------------------------------------------

/**
 * Runs a query directly against the local runtime DB for a given region.
 * Supports 'us-east-1' (port 5437) and 'eu-west-1' (port 5438) in local dev.
 */
export async function queryRuntimeDb(
  region: string,
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult> {
  const connectionString = RUNTIME_DB_URLS_BY_REGION[region] ?? RUNTIME_DB_URL_US;
  const pool = new pg.Pool({ connectionString });
  try {
    return await pool.query(sql, params);
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// deployFunctionAsOwner — POST /v1/:appId/functions as the app owner
// ---------------------------------------------------------------------------

export interface DeployFunctionArgs {
  name: string;
  code: string;
  trigger_type?: 'http' | 'cron' | 's3_upload' | 'webhook' | 'websocket';
  trigger_config?: Record<string, unknown>;
}

/**
 * Deploys a function to an app via `POST /v1/:appId/functions`. Throws if the
 * HTTP response is not 2xx.
 */
export async function deployFunctionAsOwner(
  apiKey: string,
  appId: string,
  fn: DeployFunctionArgs,
): Promise<void> {
  const res = await fetch(`${API_URL}/v1/${appId}/functions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: fn.name,
      code: fn.code,
      trigger: {
        type: fn.trigger_type ?? 'http',
        config: fn.trigger_config ?? { auth: 'none' },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`deployFunctionAsOwner failed: ${res.status} ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------

/**
 * Connects directly to the per-app Postgres database (local data-plane, port
 * 5435) and runs a single query. The app's `db_name` is resolved from the
 * runtime DB first.
 *
 * Only works in local dev where the data-plane DB is exposed on localhost:5435.
 */
export async function queryAppDb(
  runtimePool: pg.Pool,
  appId: string,
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult> {
  // Look up the per-app DB name from the runtime DB.
  const appRow = await runtimePool.query<{ db_name: string }>(
    `SELECT db_name FROM apps WHERE id = $1`,
    [appId],
  );
  if (appRow.rows.length === 0) {
    throw new Error(`queryAppDb: app ${appId} not found in runtime DB`);
  }
  const dbName = appRow.rows[0].db_name;
  const appPool = new pg.Pool({
    connectionString: `postgresql://butterbase:butterbase_dev@localhost:5435/${dbName}`,
  });
  try {
    return await appPool.query(sql, params);
  } finally {
    await appPool.end();
  }
}
