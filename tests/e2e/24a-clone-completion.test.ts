/**
 * E2E — Phase 5 / Task A7: clone worker finalizes dest correctly.
 *
 * Verifies that after a same-region (us-east-1 → us-east-1) clone completes:
 *   - clone job status = 'completed'
 *   - dest app.db_provisioned = true
 *   - source app.fork_count = 1 (A7 worker explicit bump — migration 014 has no INSERT trigger)
 *
 * The fork_count assertion validates the A7 worker increment fires for same-region clones.
 * For cross-region clones the same path is exercised; the worker always owns the increment.
 *
 * Drives control-api at http://localhost:4000.
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

describe('Phase 5 A7 — clone completion finalizes dest', () => {
  it('dest.db_provisioned=true and clone status=completed after a clean same-region clone', async () => {
    // 1. Provision a real source app via the init route.
    const sourceOwner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'a7-src');

    const sourceInitRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'a7-completion-source' }),
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
    await pushSnapshot(sourceOwner.apiKey, sourceAppId, '# a7-completion source\n');

    // 5. Clone as a different user (same region us-east-1).
    const cloner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'a7-cln');

    const cloneRes = await fetch(`${API_URL}/v1/templates/${sourceAppId}/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'a7-completion-dest', dest_region: 'us-east-1' }),
    });
    expect(cloneRes.status, await cloneRes.clone().text()).toBe(200);
    const cloneBody = await cloneRes.json() as { job_id: string; status: string };
    expect(cloneBody.job_id).toMatch(/^cj_/);

    // 6. Wait for completion.
    const final = await waitForCloneStep(
      cloner.apiKey,
      cloneBody.job_id,
      ['completed', 'failed'],
      180_000,
    );
    expect(final.status, `Clone job ended with unexpected status: ${JSON.stringify(final)}`).toBe('completed');
    expect(final.dest_app_id).toBeTruthy();

    const destAppId = final.dest_app_id!;

    // 7. Assert dest.db_provisioned = true (A7 explicit finalization).
    const destRow = await queryRuntimeDb(
      'us-east-1',
      `SELECT db_provisioned FROM apps WHERE id = $1`,
      [destAppId],
    );
    expect(destRow.rows).toHaveLength(1);
    expect(destRow.rows[0].db_provisioned).toBe(true);

    // 8. Assert source.fork_count = 1 (A7 explicit worker increment).
    // Migration 014 only installs a delete-decrement trigger; the worker is always
    // responsible for the increment. After one clean clone, fork_count must be 1.
    const srcRow = await queryRuntimeDb(
      'us-east-1',
      `SELECT fork_count FROM apps WHERE id = $1`,
      [sourceAppId],
    );
    expect(srcRow.rows).toHaveLength(1);
    expect(srcRow.rows[0].fork_count).toBe(1);

    // 9. Assert auth_audit_logs rows on SOURCE app (C1: clone lifecycle audit).
    // Two rows expected: template_clone_started + template_clone_completed.
    // Written by the worker into the control-plane DB (where auth_audit_logs lives).
    const audit = await controlPool.query(
      `SELECT event_type, event_data FROM auth_audit_logs
       WHERE app_id = $1 AND event_type LIKE 'template_clone_%'
       ORDER BY created_at`,
      [sourceAppId],
    );
    expect(audit.rows.map((r: { event_type: string }) => r.event_type)).toEqual([
      'template_clone_started',
      'template_clone_completed',
    ]);
    expect(audit.rows[1].event_data.dest_app_id).toBe(destAppId);
  }, 300_000);
});
