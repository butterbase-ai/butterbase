/**
 * E2E — Phase 5 / Task A2: clone worker replays source RLS policies onto dest DB.
 *
 * Seeds a source app (us-east-1) with a `posts` table, applies an RLS policy
 * via the HTTP RLS endpoint, marks the app public+listed, pushes a snapshot,
 * starts a clone, waits for completion, then directly asserts that pg_policies
 * on the dest DB contains the replayed policy.
 *
 * Drives control-api at http://localhost:4000.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

import {
  CONTROL_DB_URL,
  RUNTIME_DB_URL_US,
  seedUserAndApp,
  applySchemaAsOwner,
  waitForCloneStep,
  waitForProvisioning,
  pushSnapshot,
  queryAppDb,
} from './helpers/templates.js';

const API_URL = 'http://localhost:4000';

let controlPool: pg.Pool;
let runtimePool: pg.Pool;

beforeAll(async () => {
  controlPool = new pg.Pool({ connectionString: CONTROL_DB_URL });
  runtimePool = new pg.Pool({ connectionString: RUNTIME_DB_URL_US });

  // Sanity: control-api reachable.
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

describe('Phase 5 A2 — clone worker replays source RLS policies onto dest', () => {
  it('copies pg_policies entries from source onto dest DB', async () => {
    // 1. Create source app via the real init route (provisions an actual DB).
    const sourceOwner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'rlsreplay-src');

    const sourceInitRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'rls-replay-source' }),
    });
    if (!sourceInitRes.ok) {
      throw new Error(
        `POST /init for source failed: ${sourceInitRes.status} ${await sourceInitRes.text()}`,
      );
    }
    const sourceInitBody = await sourceInitRes.json() as { app_id: string };
    const sourceAppId = sourceInitBody.app_id;

    // 2. Wait for the source app's DB to be provisioned.
    await waitForProvisioning(sourceOwner.apiKey, sourceAppId, 120_000);

    // 3. Apply schema — posts table with owner_id for RLS.
    const schemaDsl = {
      tables: {
        posts: {
          columns: {
            id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
            owner_id: { type: 'uuid', nullable: true },
            title: { type: 'text', nullable: false },
          },
        },
      },
    };
    await applySchemaAsOwner(sourceOwner.apiKey, sourceAppId, schemaDsl);

    // 4. Apply an RLS policy to the source app via the standard RLS endpoint.
    //    POST /v1/:app_id/rls creates the user-isolation policy.
    const rlsRes = await fetch(`${API_URL}/v1/${sourceAppId}/rls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ table_name: 'posts', user_column: 'owner_id' }),
    });
    expect(rlsRes.status, `RLS create failed: ${await rlsRes.clone().text()}`).toBe(200);

    // 5. Mark source public+listed (required for clone).
    const patchRes = await fetch(`${API_URL}/v1/${sourceAppId}/config/visibility`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    expect(patchRes.status, await patchRes.clone().text()).toBe(200);

    // 6. Push a snapshot (required for clone to proceed).
    await pushSnapshot(sourceOwner.apiKey, sourceAppId, '# rls-replay source\n');

    // 7. Create a cloner user + clone.
    const cloner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'rlsreplay-cln');

    const cloneRes = await fetch(`${API_URL}/v1/templates/${sourceAppId}/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'rls-replay-dest' }),
    });
    expect(cloneRes.status, await cloneRes.clone().text()).toBe(200);
    const cloneBody = await cloneRes.json() as { job_id: string; status: string };
    expect(cloneBody.job_id).toMatch(/^cj_/);

    // 8. Wait for the clone job to reach 'completed' (or 'failed').
    const final = await waitForCloneStep(
      cloner.apiKey,
      cloneBody.job_id,
      ['completed', 'failed'],
      120_000,
    );
    expect(final.status, `Clone job ended with unexpected status: ${JSON.stringify(final)}`).toBe('completed');
    expect(final.dest_app_id).toBeTruthy();

    const destAppId = final.dest_app_id!;

    // 9. Direct DB assertion: the dest DB should have the replayed policy on `posts`.
    const policiesResult = await queryAppDb(
      runtimePool,
      destAppId,
      `SELECT policyname, tablename FROM pg_policies WHERE tablename = 'posts' ORDER BY policyname`,
    );

    expect(
      policiesResult.rows.length,
      `Expected at least one RLS policy on posts in dest, got: ${JSON.stringify(policiesResult.rows)}`,
    ).toBeGreaterThan(0);

    // The user-isolation policy should be present by name.
    const policyNames = policiesResult.rows.map((r: { policyname: string }) => r.policyname);
    expect(
      policyNames,
      `Expected posts_user_isolation policy in dest, got: ${JSON.stringify(policyNames)}`,
    ).toContain('posts_user_isolation');
  }, 300_000);
});
