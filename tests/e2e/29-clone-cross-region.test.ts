/**
 * E2E — Phase 5 / Task B1: cross-region clone end-to-end.
 *
 * Verifies that a clone from us-east-1 → eu-west-1 completes successfully:
 *   - clone job status = 'completed'
 *   - dest app row lands in the eu-west-1 runtime DB
 *   - source app fork_count is incremented (on the us-east-1 runtime DB)
 *
 * Drives control-api at http://localhost:4000.
 * Requires both runtime-plane-db (port 5437) and runtime-plane-db-eu (port 5438)
 * to be running (standard docker-compose.local.yml setup).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

import {
  CONTROL_DB_URL,
  RUNTIME_DB_URL_US,
  seedUserAndApp,
  waitForCloneStep,
  waitForProvisioning,
  pushSnapshot,
  queryRuntimeDb,
} from './helpers/templates.js';

const API_URL = 'http://localhost:4000';
const DEST_REGION = 'eu-west-1';

let controlPool: pg.Pool;
let runtimePool: pg.Pool;

beforeAll(async () => {
  controlPool = new pg.Pool({ connectionString: CONTROL_DB_URL });
  runtimePool = new pg.Pool({ connectionString: RUNTIME_DB_URL_US });

  const health = await fetch(`${API_URL}/health`);
  if (!health.ok) {
    throw new Error(`control-api /health unreachable at ${API_URL} — status ${health.status}`);
  }
}, 30_000);

afterAll(async () => {
  await controlPool?.end();
  await runtimePool?.end();
}, 30_000);

describe('Phase 5 B1 — cross-region clone', () => {
  it('clones from us-east-1 to eu-west-1 successfully', async () => {
    // 1. Provision a source app in us-east-1 via the init route.
    const sourceOwner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'b1-src');

    const sourceInitRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'b1-cross-region-source' }),
    });
    if (!sourceInitRes.ok) {
      throw new Error(`POST /init for source failed: ${sourceInitRes.status} ${await sourceInitRes.text()}`);
    }
    const sourceInitBody = await sourceInitRes.json() as { app_id: string };
    const sourceAppId = sourceInitBody.app_id;

    // 2. Wait for source DB provisioning.
    await waitForProvisioning(sourceOwner.apiKey, sourceAppId, 120_000);

    // 3. Mark source public+listed so it is clonable.
    const patchRes = await fetch(`${API_URL}/v1/${sourceAppId}/config/visibility`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    expect(patchRes.status, await patchRes.clone().text()).toBe(200);

    // 4. Push a snapshot (required for the clone worker to proceed).
    await pushSnapshot(sourceOwner.apiKey, sourceAppId, '# b1-cross-region source\n');

    // 5. Clone as a different user, targeting eu-west-1.
    const cloner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'b1-cln');

    const cloneRes = await fetch(`${API_URL}/v1/templates/${sourceAppId}/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'b1-cross-region-dest', dest_region: DEST_REGION }),
    });
    expect(cloneRes.status, await cloneRes.clone().text()).toBe(200);
    const cloneBody = await cloneRes.json() as { job_id: string; status: string };
    expect(cloneBody.job_id).toMatch(/^cj_/);

    // 6. Wait for completion (allow extra time for cross-region provisioning).
    const final = await waitForCloneStep(
      cloner.apiKey,
      cloneBody.job_id,
      ['completed', 'failed'],
      240_000,
    );
    expect(final.status, `Clone job ended with unexpected status: ${JSON.stringify(final)}`).toBe('completed');
    expect(final.dest_app_id).toBeTruthy();

    const destAppId = final.dest_app_id!;

    // 7. Assert dest app row is in the EU runtime DB with the correct region tag.
    const destRow = await queryRuntimeDb(
      DEST_REGION,
      `SELECT region, db_provisioned FROM apps WHERE id = $1`,
      [destAppId],
    );
    expect(destRow.rows).toHaveLength(1);
    expect(destRow.rows[0].region).toBe(DEST_REGION);
    expect(destRow.rows[0].db_provisioned).toBe(true);

    // 8. Assert source.fork_count incremented (checked on the us-east-1 runtime DB).
    const srcRow = await queryRuntimeDb(
      'us-east-1',
      `SELECT fork_count FROM apps WHERE id = $1`,
      [sourceAppId],
    );
    expect(srcRow.rows).toHaveLength(1);
    expect(srcRow.rows[0].fork_count).toBeGreaterThanOrEqual(1);
  }, 300_000);
});
