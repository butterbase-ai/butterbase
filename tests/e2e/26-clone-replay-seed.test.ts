/**
 * E2E — Phase 5 / Task A3: clone worker copies seed-flagged table rows onto dest DB.
 *
 * Seeds a source app with a `countries` table (_seed: true) and a `users` table
 * (no _seed flag), inserts rows into both, marks the app public+listed, pushes a
 * snapshot, starts a clone, waits for completion, then asserts:
 *   - countries rows are present on the dest DB (seed-flagged → copied)
 *   - users rows are absent from the dest DB (not flagged → skipped)
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
  insertRowsAsOwner,
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

describe('Phase 5 A3 — clone copies seed rows', () => {
  it('rows in _seed-flagged tables travel with the clone; non-seed rows do not', async () => {
    // 1. Create source app via the real init route (provisions an actual DB).
    const sourceOwner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'seedcopy-src');

    const sourceInitRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'seed-copy-source' }),
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

    // 3. Apply schema — countries (seed-flagged) + users (not flagged).
    const schemaDsl = {
      tables: {
        countries: {
          _seed: true,
          columns: {
            code: { type: 'text', primaryKey: true },
            name: { type: 'text' },
          },
        },
        users: {
          columns: {
            id: { type: 'uuid', primaryKey: true },
            name: { type: 'text' },
          },
        },
      },
    };
    await applySchemaAsOwner(sourceOwner.apiKey, sourceAppId, schemaDsl);

    // 4. Insert seed rows into countries and a non-seed row into users.
    await insertRowsAsOwner(sourceOwner.apiKey, sourceAppId, 'countries', [
      { code: 'US', name: 'United States' },
      { code: 'EU', name: 'European Union' },
    ]);
    await insertRowsAsOwner(sourceOwner.apiKey, sourceAppId, 'users', [
      { id: '00000000-0000-0000-0000-000000000001', name: 'alice' },
    ]);

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
    await pushSnapshot(sourceOwner.apiKey, sourceAppId, '# seed-copy source\n');

    // 7. Create a cloner user + clone.
    const cloner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'seedcopy-cln');

    const cloneRes = await fetch(`${API_URL}/v1/templates/${sourceAppId}/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'replica-seed' }),
    });
    expect(cloneRes.status, await cloneRes.clone().text()).toBe(200);
    const cloneBody = await cloneRes.json() as { job_id: string; status: string };
    expect(cloneBody.job_id).toMatch(/^cj_/);

    // 8. Wait for the clone job to reach 'completed' (or 'failed').
    const final = await waitForCloneStep(
      cloner.apiKey,
      cloneBody.job_id,
      ['completed', 'failed'],
      180_000,
    );
    expect(final.status, `Clone job ended with unexpected status: ${JSON.stringify(final)}`).toBe('completed');
    expect(final.dest_app_id).toBeTruthy();

    const destAppId = final.dest_app_id!;

    // 9. Assert countries rows were copied (seed-flagged).
    const countries = await queryAppDb(
      runtimePool,
      destAppId,
      `SELECT code FROM countries ORDER BY code`,
    );
    expect(
      countries.rows.map((r: { code: string }) => r.code).sort(),
      `Expected ['EU', 'US'] in dest countries, got: ${JSON.stringify(countries.rows)}`,
    ).toEqual(['EU', 'US']);

    // 10. Assert users rows were NOT copied (no _seed flag).
    const users = await queryAppDb(
      runtimePool,
      destAppId,
      `SELECT id FROM users`,
    );
    expect(
      users.rows,
      `Expected no user rows in dest, got: ${JSON.stringify(users.rows)}`,
    ).toEqual([]);
  }, 240_000);
});
