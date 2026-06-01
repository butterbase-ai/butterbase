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
  destAppId: string | null;
}

/**
 * Calls `POST /v1/templates/:sourceAppId/clone` and returns `{ jobId, destAppId }`.
 * `destAppId` is null immediately after creation (assigned by the worker later).
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
  return { jobId: j.job_id, destAppId: null };
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
