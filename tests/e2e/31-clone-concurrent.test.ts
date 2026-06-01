/**
 * E2E — Phase 5 / Task G3: two concurrent clones; pinned snapshot survives retention.
 *
 * Verifies two properties of the clone worker's "pin source snapshot at start" behaviour:
 *
 *   1. Two concurrent clones of the same source app both complete successfully
 *      (no race or deadlock between workers reading the source's repo).
 *
 *   2. The snapshot pinned by the clones at job-create time survives even after
 *      additional source pushes that would otherwise prune it via retention
 *      (REPO_RETAIN_SNAPSHOTS = 5). Both dest apps receive the v1 manifest content,
 *      not the latest v8 content.
 *
 * Pin mechanism: createCloneJob stores source_snapshot_id at enqueue time
 * (db/control-plane/082_template_clone_jobs.sql). listActiveCloneSnapshotIdsForApp
 * (services/clone-jobs.ts) feeds that id into planRetention's pinned set whenever
 * the source app's commit endpoint runs retention logic.
 *
 * Drives control-api at http://localhost:4000.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';

import {
  CONTROL_DB_URL,
  RUNTIME_DB_URL_US,
  seedUserAndApp,
  waitForProvisioning,
  startCloneJob,
  waitForCloneStep,
  pushFileSnapshot,
} from './helpers/templates.js';

const API_URL = 'http://localhost:4000';

let controlPool: pg.Pool;
let runtimePool: pg.Pool;

beforeAll(async () => {
  controlPool = new pg.Pool({ connectionString: CONTROL_DB_URL });
  runtimePool = new pg.Pool({ connectionString: RUNTIME_DB_URL_US });

  const health = await fetch(`${API_URL}/health`);
  if (!health.ok) {
    throw new Error(`control-api /health unreachable at ${API_URL} — status ${health.status}`);
  }
  // Confirm clone routes registered.
  const probe = await fetch(`${API_URL}/v1/clone-jobs/cj_doesnotexist`, {
    headers: { Authorization: 'Bearer bb_sk_invalid' },
  });
  if (probe.status !== 401 && probe.status !== 404) {
    throw new Error(`/v1/clone-jobs/:id probe returned unexpected ${probe.status}`);
  }
}, 30_000);

afterAll(async () => {
  await controlPool?.end();
  await runtimePool?.end();
}, 30_000);

describe('Phase 5 G3 — two concurrent clones; pinned snapshot survives retention pressure', () => {
  it('both clones complete; both dest apps reflect the v1 snapshot pinned at job-create time', async () => {
    // --- 1. Provision the source app via the API so its per-app DB exists ---
    // seedUserAndApp creates the user/key/row but not the actual Postgres DB.
    // The clone worker reads the source DB for schema/RLS replay, so the source
    // must be fully provisioned before cloning begins.
    const srcOwner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'g3-src');

    const sourceInitRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${srcOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'g3-concurrent-source' }),
    });
    if (!sourceInitRes.ok) {
      throw new Error(`POST /init for source failed: ${sourceInitRes.status} ${await sourceInitRes.text()}`);
    }
    const sourceInitBody = await sourceInitRes.json() as { app_id: string };
    const srcAppId = sourceInitBody.app_id;
    const srcApiKey = srcOwner.apiKey;

    // Wait for the source app's DB to be ready.
    await waitForProvisioning(srcApiKey, srcAppId, 120_000);

    // Mark the app public+listed so the clone endpoint accepts it.
    const patchRes = await fetch(`${API_URL}/v1/${srcAppId}/config/visibility`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${srcApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    if (!patchRes.ok) {
      throw new Error(`visibility patch failed: ${patchRes.status} ${await patchRes.text()}`);
    }

    // --- 2. Push the snapshot that BOTH clones will pin ---
    // Both clone jobs are created before any further pushes, so this is the snapshot
    // captured in source_snapshot_id for both jobs.
    const v1Content = 'v1';
    await pushFileSnapshot(srcApiKey, srcAppId, 'a.txt', v1Content);
    const v1Hash = createHash('sha256').update(v1Content).digest('hex');

    // --- 3. Start BOTH clones before pushing any more snapshots ---
    // The clone endpoint reads apps.repo_latest_snapshot and records it as
    // source_snapshot_id in template_clone_jobs (the "pin").
    const job1 = await startCloneJob(srcApiKey, srcAppId, 'g3-dest-1', 'us-east-1');
    const job2 = await startCloneJob(srcApiKey, srcAppId, 'g3-dest-2', 'us-east-1');

    // --- 4. Retention pressure: push 7 more snapshots ---
    // REPO_RETAIN_SNAPSHOTS = 5.  After 7 more pushes the v1 snapshot is the oldest
    // of 8 total and would normally be pruned.  The in-flight clone pins protect it.
    for (let i = 2; i <= 8; i++) {
      await pushFileSnapshot(srcApiKey, srcAppId, 'a.txt', `v${i}`);
    }

    // --- 5. Wait for both clones to reach a terminal state ---
    const final1 = await waitForCloneStep(
      srcApiKey,
      job1.jobId,
      ['completed', 'failed'],
      300_000,
    );
    const final2 = await waitForCloneStep(
      srcApiKey,
      job2.jobId,
      ['completed', 'failed'],
      300_000,
    );

    expect(
      final1.status,
      `Clone job 1 ended unexpectedly: ${JSON.stringify(final1)}`,
    ).toBe('completed');
    expect(
      final2.status,
      `Clone job 2 ended unexpectedly: ${JSON.stringify(final2)}`,
    ).toBe('completed');

    const destAppId1 = final1.dest_app_id!;
    const destAppId2 = final2.dest_app_id!;
    expect(destAppId1).toBeTruthy();
    expect(destAppId2).toBeTruthy();

    // --- 6. Verify: each dest's latest manifest still contains 'a.txt' with v1 sha256 ---
    // The dest apps are owned by src.userId (the cloner), so src.apiKey can read them.
    //
    // This is the medium-strength pin assertion: instead of just checking the file
    // exists, we verify its sha256 matches sha256('v1'), proving the worker copied the
    // pinned snapshot's blob — NOT the latest source snapshot (which contains 'v8').

    const latestRes1 = await fetch(
      `${API_URL}/v1/${destAppId1}/repo/snapshots/latest`,
      { headers: { Authorization: `Bearer ${srcApiKey}` } },
    );
    expect(
      latestRes1.status,
      `snapshots/latest for dest1 returned ${latestRes1.status}`,
    ).toBe(200);
    const latest1 = await latestRes1.json() as {
      snapshot_id: string;
      manifest: { files: Array<{ path: string; sha256: string; size: number }> };
    };

    const latestRes2 = await fetch(
      `${API_URL}/v1/${destAppId2}/repo/snapshots/latest`,
      { headers: { Authorization: `Bearer ${srcApiKey}` } },
    );
    expect(
      latestRes2.status,
      `snapshots/latest for dest2 returned ${latestRes2.status}`,
    ).toBe(200);
    const latest2 = await latestRes2.json() as {
      snapshot_id: string;
      manifest: { files: Array<{ path: string; sha256: string; size: number }> };
    };

    // Both dest apps must have a.txt in their manifest.
    const file1 = latest1.manifest?.files?.find((f) => f.path === 'a.txt');
    const file2 = latest2.manifest?.files?.find((f) => f.path === 'a.txt');

    expect(file1, `dest1 manifest missing a.txt — full manifest: ${JSON.stringify(latest1.manifest)}`).toBeTruthy();
    expect(file2, `dest2 manifest missing a.txt — full manifest: ${JSON.stringify(latest2.manifest)}`).toBeTruthy();

    // Core pin assertion: sha256 must be sha256('v1'), not sha256('v8').
    expect(
      file1!.sha256,
      `dest1 a.txt sha256 does not match v1 — pin regression? got ${file1!.sha256}`,
    ).toBe(v1Hash);
    expect(
      file2!.sha256,
      `dest2 a.txt sha256 does not match v1 — pin regression? got ${file2!.sha256}`,
    ).toBe(v1Hash);
  }, 480_000);
});
