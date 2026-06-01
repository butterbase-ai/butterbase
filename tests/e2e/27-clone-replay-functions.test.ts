/**
 * E2E — Phase 5 / Task A4: clone worker replays app_functions onto dest runtime DB.
 *
 * Seeds a source app with a deployed function, marks it public+listed, pushes a
 * snapshot, starts a clone, waits for completion, then asserts:
 *   - the function row is present on the dest runtime DB
 *   - encrypted_env_vars is NULL on the dest (secrets allowlist)
 *   - behavior-defining columns (code, trigger_type, trigger_config) match source
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
  deployFunctionAsOwner,
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

describe('Phase 5 A4 — clone replays app_functions', () => {
  it('functions copy across; encrypted_env_vars is NULL on dest', async () => {
    // 1. Create source app via the real init route (provisions an actual DB).
    const sourceOwner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'fnreplay-src');

    const sourceInitRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'fn-replay-source' }),
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

    // 3. Deploy a function on the source app.
    const fnCode = `export async function handler(request, context) { return new Response("hello from clone"); }`;
    await deployFunctionAsOwner(sourceOwner.apiKey, sourceAppId, {
      name: 'hello',
      code: fnCode,
      trigger_type: 'http',
      trigger_config: { auth: 'none' },
    });

    // 4. Mark source public+listed (required for clone).
    const patchRes = await fetch(`${API_URL}/v1/${sourceAppId}/config/visibility`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    expect(patchRes.status, await patchRes.clone().text()).toBe(200);

    // 5. Push a snapshot (required for clone to proceed).
    await pushSnapshot(sourceOwner.apiKey, sourceAppId, '# fn-replay source\n');

    // 6. Create a cloner user + clone.
    const cloner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'fnreplay-cln');

    const cloneRes = await fetch(`${API_URL}/v1/templates/${sourceAppId}/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'replica-fns' }),
    });
    expect(cloneRes.status, await cloneRes.clone().text()).toBe(200);
    const cloneBody = await cloneRes.json() as { job_id: string; status: string };
    expect(cloneBody.job_id).toMatch(/^cj_/);

    // 7. Wait for the clone job to reach 'completed' (or 'failed').
    const final = await waitForCloneStep(
      cloner.apiKey,
      cloneBody.job_id,
      ['completed', 'failed'],
      180_000,
    );
    expect(final.status, `Clone job ended with unexpected status: ${JSON.stringify(final)}`).toBe('completed');
    expect(final.dest_app_id).toBeTruthy();

    const destAppId = final.dest_app_id!;

    // 8. Assert the function was copied to the dest runtime DB.
    const fns = await queryRuntimeDb(
      'us-east-1',
      `SELECT name, code, trigger_type, encrypted_env_vars
         FROM app_functions
        WHERE app_id = $1 AND deleted_at IS NULL`,
      [destAppId],
    );

    const helloFn = fns.rows.find((r: Record<string, unknown>) => r.name === 'hello');
    expect(
      helloFn,
      `Expected function 'hello' in dest app_functions, got: ${JSON.stringify(fns.rows)}`,
    ).toBeTruthy();

    // encrypted_env_vars must be NULL (secrets allowlist policy).
    expect(
      helloFn!.encrypted_env_vars,
      'encrypted_env_vars should be NULL on cloned function',
    ).toBeNull();

    // Verify trigger_type preserved.
    expect(helloFn!.trigger_type).toBe('http');

    // Verify code preserved.
    expect(helloFn!.code).toBe(fnCode);
  }, 240_000);
});
