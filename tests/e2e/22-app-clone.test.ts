/**
 * E2E — Phase 4a app-template clone mechanic against the running docker-compose stack.
 *
 * Drives the rebuilt control-api at http://localhost:4000 end-to-end:
 *   POST /v1/templates/:source_app_id/clone
 *   GET  /v1/clone-jobs/:job_id
 *   POST /v1/clone-jobs/:job_id/retry
 *
 * Five cases:
 *   1. Happy-path same-region clone (us-east-1 → us-east-1).
 *   2. Private source → 404.
 *   3. Public source without a snapshot → 400 VALIDATION_INVALID_SCHEMA.
 *   4. Forced failure (bad source_snapshot_id) → job lands 'failed' → restore manifest → retry → 'completed'.
 *   5. Retention pin: an in-flight clone keeps its source snapshot from being pruned
 *      even after more than REPO_RETAIN_SNAPSHOTS (=5) newer snapshots are pushed.
 *
 * Seeds users/apps directly into the running control-plane + runtime-plane DBs
 * (same pattern as 21-app-repo-cli-integration.test.ts). Auth via real bb_sk_*
 * keys inserted into api_keys — the bb_sk_ branch in plugins/auth.ts runs
 * regardless of AUTH_ENABLED.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import pg from 'pg';
import { RATE_LIMIT_BYPASS_HEADERS, waitForProvisioning } from './helpers/templates.js';

const API_URL = 'http://localhost:4000';
const CONTROL_DB_URL = 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
const RUNTIME_DB_URL_US = 'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

const S3_ENDPOINT = 'http://localhost:4566';
const S3_BUCKET = 'butterbase-app-storage';
const S3_REGION = 'us-east-1';

let controlPool: pg.Pool;
let runtimePool: pg.Pool;
let s3: S3Client;

interface SeededUser { userId: string; apiKey: string; }
interface SeededApp { userId: string; appId: string; apiKey: string; }

function generateApiKey(): { fullKey: string; keyHash: string; keyPrefix: string } {
  const fullKey = `bb_sk_${randomBytes(20).toString('hex')}`;
  const keyHash = createHash('sha256').update(fullKey).digest('hex');
  return { fullKey, keyHash, keyPrefix: fullKey.substring(0, 12) };
}

async function seedUser(): Promise<SeededUser> {
  const stamp = Date.now() + Math.random().toString(36).slice(2, 8);
  const email = `clone-e2e-${stamp}@example.com`;
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
    [userId, keyHash, keyPrefix, 'clone-e2e', ['*'], 'app', null],
  );
  return { userId, apiKey: fullKey };
}

async function seedUserAndApp(region: string): Promise<SeededApp> {
  const u = await seedUser();
  const res = await fetch(`${API_URL}/init`, {
    method: 'POST',
    headers: {
      ...RATE_LIMIT_BYPASS_HEADERS,
      Authorization: `Bearer ${u.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'clone-e2e', region }),
  });
  if (!res.ok) throw new Error(`/init failed: ${res.status} ${await res.text()}`);
  const init = await res.json() as { app_id: string };
  await waitForProvisioning(u.apiKey, init.app_id, 120_000);
  return { userId: u.userId, appId: init.app_id, apiKey: u.apiKey };
}

async function setVisibilityPublic(appId: string): Promise<void> {
  await runtimePool.query(
    `UPDATE apps SET visibility = 'public', listed = true, updated_at = now() WHERE id = $1`,
    [appId],
  );
}

/**
 * Push a single-file snapshot for a source app: blob upload → prepare → commit.
 * Each call uses a unique file body so each snapshot has a different snapshot_id.
 */
async function pushSnapshot(appId: string, apiKey: string, body: string): Promise<string> {
  const sha256 = createHash('sha256').update(body).digest('hex');
  const size = Buffer.byteLength(body, 'utf8');
  const path = 'README.md';
  const manifestBody = { files: [{ path, sha256, size }] };

  // prepare → presigned upload URL for missing blob
  const prep = await fetch(`${API_URL}/v1/${appId}/repo/snapshots/prepare`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(manifestBody),
  });
  if (!prep.ok) throw new Error(`prepare failed: ${prep.status} ${await prep.text()}`);
  const pj = await prep.json() as { snapshot_id: string; missing_blobs: { sha256: string; uploadUrl: string }[] };

  for (const mb of pj.missing_blobs) {
    const put = await fetch(mb.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
    if (!put.ok) throw new Error(`blob upload failed: ${put.status} ${await put.text()}`);
  }

  const commit = await fetch(`${API_URL}/v1/${appId}/repo/snapshots/commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: manifestBody }),
  });
  if (!commit.ok) throw new Error(`commit failed: ${commit.status} ${await commit.text()}`);
  const cj = await commit.json() as { snapshot_id: string };
  return cj.snapshot_id;
}

interface CloneJobStatusRes {
  job_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  source_app_id: string;
  dest_app_id: string | null;
  retry_count: number;
  error_message: string | null;
}

async function getJob(apiKey: string, jobId: string): Promise<CloneJobStatusRes> {
  const r = await fetch(`${API_URL}/v1/clone-jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) throw new Error(`get job failed: ${r.status} ${await r.text()}`);
  return await r.json() as CloneJobStatusRes;
}

async function waitForJobStatus(
  apiKey: string,
  jobId: string,
  target: CloneJobStatusRes['status'] | CloneJobStatusRes['status'][],
  timeoutMs: number,
): Promise<CloneJobStatusRes> {
  const targets = Array.isArray(target) ? target : [target];
  const start = Date.now();
  let last: CloneJobStatusRes | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await getJob(apiKey, jobId);
    if (targets.includes(last.status)) return last;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Job ${jobId} did not reach ${targets.join('|')} within ${timeoutMs}ms (last=${JSON.stringify(last)})`);
}

beforeAll(async () => {
  controlPool = new pg.Pool({ connectionString: CONTROL_DB_URL });
  runtimePool = new pg.Pool({ connectionString: RUNTIME_DB_URL_US });
  s3 = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  // Sanity: control-api reachable and clone routes registered.
  const health = await fetch(`${API_URL}/health`);
  if (!health.ok) throw new Error(`control-api /health unreachable at ${API_URL} — ${health.status}`);
  const probe = await fetch(`${API_URL}/v1/clone-jobs/cj_doesnotexist`, {
    headers: { Authorization: 'Bearer bb_sk_invalid' },
  });
  // 401 (auth rejects invalid key) is fine — confirms route exists. 404 fine too.
  if (probe.status !== 401 && probe.status !== 404) {
    throw new Error(`/v1/clone-jobs/:id probe returned unexpected ${probe.status}`);
  }
}, 60_000);

afterAll(async () => {
  if (controlPool) await controlPool.end();
  if (runtimePool) await runtimePool.end();
  s3?.destroy();
}, 30_000);

describe('Phase 4a app-template clone (end-to-end)', () => {
  it('case 1: happy-path same-region clone completes; dest has snapshot pointer + manifest in S3', async () => {
    const source = await seedUserAndApp('us-east-1');
    const cloner = await seedUser();
    await setVisibilityPublic(source.appId);
    const snapshotId = await pushSnapshot(source.appId, source.apiKey, '# clone case 1\n');

    const res = await fetch(`${API_URL}/v1/templates/${source.appId}/clone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cloner.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cloned app c1' }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { job_id: string; status: string };
    expect(body.job_id).toMatch(/^cj_/);
    expect(body.status).toBe('pending');

    const final = await waitForJobStatus(cloner.apiKey, body.job_id, 'completed', 90_000);
    expect(final.dest_app_id).toBeTruthy();
    const destAppId = final.dest_app_id!;

    // Dest apps row has repo_latest_snapshot = source's snapshot id.
    const destRow = await runtimePool.query<{ repo_latest_snapshot: string | null; owner_id: string; template_source_app_id: string | null }>(
      `SELECT repo_latest_snapshot, owner_id, template_source_app_id FROM apps WHERE id = $1`,
      [destAppId],
    );
    expect(destRow.rows[0]?.repo_latest_snapshot).toBe(snapshotId);
    expect(destRow.rows[0]?.owner_id).toBe(cloner.userId);
    expect(destRow.rows[0]?.template_source_app_id).toBe(source.appId);

    // Dest manifest exists in S3 under the dest's prefix.
    const head = await s3.send(new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: `${destAppId}/_repo/snapshots/${snapshotId}/manifest.json`,
    }));
    expect(head.$metadata.httpStatusCode).toBe(200);

    // And /v1/<destAppId>/repo/snapshots/latest serves it (cloner is dest owner).
    const latest = await fetch(`${API_URL}/v1/${destAppId}/repo/snapshots/latest`, {
      headers: { Authorization: `Bearer ${cloner.apiKey}` },
    });
    expect(latest.status).toBe(200);
    const lj = await latest.json() as { snapshot_id: string };
    expect(lj.snapshot_id).toBe(snapshotId);
  }, 180_000);

  it('case 2: cloning a private source returns 404', async () => {
    const source = await seedUserAndApp('us-east-1');
    const cloner = await seedUser();
    // visibility stays 'private' (default).
    await pushSnapshot(source.appId, source.apiKey, '# private case 2\n');

    const res = await fetch(`${API_URL}/v1/templates/${source.appId}/clone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cloner.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const eb = await res.json() as { error: { code: string } };
    expect(eb.error.code).toBe('RESOURCE_NOT_FOUND');
  }, 60_000);

  it('case 3: cloning a public source with no snapshot returns 400 VALIDATION_INVALID_SCHEMA', async () => {
    const source = await seedUserAndApp('us-east-1');
    const cloner = await seedUser();
    await setVisibilityPublic(source.appId);
    // Deliberately no pushSnapshot — apps.repo_latest_snapshot stays NULL.

    const res = await fetch(`${API_URL}/v1/templates/${source.appId}/clone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cloner.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const eb = await res.json() as { error: { code: string } };
    expect(eb.error.code).toBe('VALIDATION_INVALID_SCHEMA');
  }, 60_000);

  it('case 4: forced failure → job=failed; restore manifest → retry → completed', async () => {
    const source = await seedUserAndApp('us-east-1');
    const cloner = await seedUser();
    await setVisibilityPublic(source.appId);
    const realSnapshotId = await pushSnapshot(source.appId, source.apiKey, '# retry case 4\n');

    // Corrupt: point repo_latest_snapshot at a manifest that does NOT exist in S3.
    // sha256 of an arbitrary string we know will not collide with any real snapshot.
    const fakeSnapshotId = createHash('sha256').update(`bogus-${Date.now()}-${Math.random()}`).digest('hex');
    await runtimePool.query(
      `UPDATE apps SET repo_latest_snapshot = $1 WHERE id = $2`,
      [fakeSnapshotId, source.appId],
    );

    // Submit clone — route reads repo_latest_snapshot, creates job with that bogus id.
    const res = await fetch(`${API_URL}/v1/templates/${source.appId}/clone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cloner.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const j = await res.json() as { job_id: string };

    // Restore the apps row immediately so subsequent retries by *other* tests
    // never trip on it; the job carries the bogus snapshot id internally regardless.
    await runtimePool.query(
      `UPDATE apps SET repo_latest_snapshot = $1 WHERE id = $2`,
      [realSnapshotId, source.appId],
    );

    // Worker retries with exponential backoff (2,4,8,16,32 = 62s).
    // Wait long enough for max_attempts=5 to be exhausted → job lands 'failed'.
    const failed = await waitForJobStatus(cloner.apiKey, j.job_id, 'failed', 150_000);
    expect(failed.status).toBe('failed');
    expect(failed.dest_app_id).toBeTruthy(); // dest provisioned on attempt 1 before manifest read

    // Plant a manifest at the bogus snapshot id pointing at a real blob in the source's prefix.
    // We seed both a tiny blob (under source's repo prefix) and a manifest referencing it.
    const restoreBody = '# restored payload\n';
    const restoreSha = createHash('sha256').update(restoreBody).digest('hex');
    const restoreSize = Buffer.byteLength(restoreBody, 'utf8');
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `${source.appId}/_repo/blobs/${restoreSha}`,
      Body: restoreBody,
      ContentType: 'application/octet-stream',
    }));
    const manifestJson = JSON.stringify({
      v: 1,
      files: [{ path: 'README.md', sha256: restoreSha, size: restoreSize }],
    });
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `${source.appId}/_repo/snapshots/${fakeSnapshotId}/manifest.json`,
      Body: manifestJson,
      ContentType: 'application/json',
    }));

    // Retry — worker should reuse dest_app_id (skip provision), copy manifest+blob, complete.
    const retryRes = await fetch(`${API_URL}/v1/clone-jobs/${j.job_id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cloner.apiKey}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(retryRes.status, await retryRes.clone().text()).toBe(200);

    const done = await waitForJobStatus(cloner.apiKey, j.job_id, 'completed', 90_000);
    expect(done.status).toBe('completed');
    expect(done.retry_count).toBeGreaterThanOrEqual(1);
    expect(done.dest_app_id).toBe(failed.dest_app_id);
  }, 300_000);

  it('Phase 5 D2 — returns 429 CLONE_LIMIT_INFLIGHT when user already has 3 non-terminal jobs', async () => {
    const src = await seedUserAndApp('us-east-1');
    await setVisibilityPublic(src.appId);
    await pushSnapshot(src.appId, src.apiKey, '# D2 cap test source\n');

    // Directly insert 3 non-terminal clone jobs for this user — one per extended status variant.
    const nonTerminalStatuses = ['processing', 'replaying_schema', 'copying_repo'];
    for (let i = 0; i < 3; i++) {
      const jobId = `cj_d2cap_${randomBytes(9).toString('hex').slice(0, 16)}_${i}`;
      await controlPool.query(
        `INSERT INTO template_clone_jobs
           (id, source_app_id, source_snapshot_id, source_region, dest_app_id, dest_region, requested_by_user_id, status, dest_app_name)
         VALUES ($1, $2, 'fake_snapshot_d2', 'us-east-1', NULL, 'us-east-1', $3, $4, $5)`,
        [jobId, src.appId, src.userId, nonTerminalStatuses[i], `cap-dummy-${i}`],
      );
    }

    try {
      // Attempt a 4th clone via the API — should be rejected with 429.
      const res = await fetch(`${API_URL}/v1/templates/${src.appId}/clone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${src.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ dest_app_name: 'over-cap', dest_region: 'us-east-1' }),
      });
      expect(res.status).toBe(429);
      const body = await res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('CLONE_LIMIT_INFLIGHT');
      expect(body.error.message).toContain('3 clones in progress');
    } finally {
      // Clean up stub jobs so they don't affect other tests.
      await controlPool.query(
        `DELETE FROM template_clone_jobs WHERE requested_by_user_id = $1 AND id LIKE 'cj_d2cap_%'`,
        [src.userId],
      );
    }
  }, 90_000);

  it('case 5: retention pin protects an in-flight clone source snapshot from pruning', async () => {
    // Strategy: directly insert a clone_job row in 'processing' status (NO neon_task
    // enqueued) so it stays in-flight indefinitely. Then push 7 snapshots (>retain=5)
    // to the source. The commit endpoint runs planRetention with
    // listActiveCloneSnapshotIdsForApp; the pinned snapshot must survive in S3.
    const source = await seedUserAndApp('us-east-1');
    await setVisibilityPublic(source.appId);

    // Push snapshot[0] — this is the one we will pin.
    const pinnedSnapshotId = await pushSnapshot(source.appId, source.apiKey, '# pinned snapshot c5\n');

    // Stub a clone job in 'processing' status that references the pinned snapshot
    // but never enqueues a worker task. The job rules out completion.
    const stubJobId = 'cj_stub_' + randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    await controlPool.query(
      `INSERT INTO template_clone_jobs
         (id, source_app_id, source_snapshot_id, source_region, dest_region, requested_by_user_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'processing')`,
      [stubJobId, source.appId, pinnedSnapshotId, 'us-east-1', 'us-east-1', source.userId],
    );

    try {
      // Push 7 more snapshots. With retain=5 and the pinned one (which is now the
      // OLDEST of 8 total), without the pin the pinned snapshot would be pruned at
      // push #6 onward. With the pin, it must survive.
      for (let i = 1; i <= 7; i++) {
        await pushSnapshot(source.appId, source.apiKey, `# extra snapshot ${i}\n`);
      }

      // Verify: pinned snapshot's manifest still exists in S3.
      const head = await s3.send(new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${source.appId}/_repo/snapshots/${pinnedSnapshotId}/manifest.json`,
      }));
      expect(head.$metadata.httpStatusCode).toBe(200);

      // Sanity: confirm the prune *did* happen for some non-pinned snapshot —
      // total live snapshot dirs under the source prefix should be retain(5) + 1(pinned) = 6
      // (or fewer if S3 list eventual consistency lags, but localstack is strong).
      const listed = await s3.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: `${source.appId}/_repo/snapshots/`,
        Delimiter: '/',
      }));
      const snapshotDirs = (listed.CommonPrefixes ?? []).map(p => p.Prefix!);
      // Confirm pruning happened: not every one of the 8 pushed snapshots remains.
      expect(snapshotDirs.length).toBeLessThanOrEqual(7); // pinned + retain(5) + the just-pushed (counted in retain)
      // And the pinned dir is present.
      const pinnedPrefix = `${source.appId}/_repo/snapshots/${pinnedSnapshotId}/`;
      expect(snapshotDirs).toContain(pinnedPrefix);
    } finally {
      // Mark the stub job complete + clean up so we don't leak in-flight pins.
      await controlPool.query(
        `UPDATE template_clone_jobs SET status = 'completed', completed_at = now() WHERE id = $1`,
        [stubJobId],
      );
      // Also clean the planted manifest+blob and pinned dir to keep localstack tidy.
      const prefix = `${source.appId}/_repo/snapshots/${pinnedSnapshotId}/`;
      const objs = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix }));
      for (const o of objs.Contents ?? []) {
        if (o.Key) await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: o.Key })).catch(() => {});
      }
    }
  }, 180_000);
});
