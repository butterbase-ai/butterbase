import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import runtimeDatabasePlugin from '../plugins/runtime-database.js';
import authPlugin from '../plugins/auth.js';
import { initRoutes } from '../routes/init.js';
import { apiKeyRoutes } from '../routes/api-keys.js';
import { autoApiRoutes } from '../routes/auto-api.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';

// End-to-end integration for app-scoped service keys + impersonation.
//
// Verifies the contract introduced by tasks 1–5 of the app-scoped-service-keys
// plan:
//   - validator rejects mismatched key_scope/target_app_id combos
//   - mint(app:A) is required to send X-Butterbase-As-User to /v1/A/fn/...
//   - account-scoped keys (scope='*') cannot impersonate
//   - app-scoped key for A cannot impersonate against /v1/B/fn/...
//   - functions with trigger_config.auth='required' refuse anonymous callers
//
// Uses the same real-Postgres pattern as auth-function-key.test.ts: control DB
// at :5433, runtime DB at :5437. /init provisions the apps; we seed the
// `app_functions` + `function_triggers` rows directly so we don't have to
// shell out to a deploy service.

process.env.AUTH_ENABLED = 'true';
process.env.BUTTERBASE_E2E = '1';
process.env.BUTTERBASE_REGIONS = process.env.BUTTERBASE_REGIONS ?? 'us-east-1';
process.env.BUTTERBASE_REGION = process.env.BUTTERBASE_REGION ?? 'us-east-1';
process.env.NEON_DATA_PROJECT_ID_US_EAST_1 =
  process.env.NEON_DATA_PROJECT_ID_US_EAST_1 ?? 'local-dev-data-project';
process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 =
  process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ??
  'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let app: FastifyInstance;
let appA: string;
let appB: string;
let accountKey: string;
let appAKey: string;
// Two functions per app:
//   - PROTECTED_FN: trigger_config.auth='required' — used to assert the 401
//     AUTH_REQUIRED path fires when an app-scoped key alone (no impersonation
//     header) hits it.
//   - OPEN_FN: trigger_config.auth='none' — used for the impersonation-gate
//     assertions. The 401 AUTH_REQUIRED check runs *before* the gate; if the
//     function were auth:required, the gate's 403 AUTH_IMPERSONATION_FORBIDDEN
//     would be masked by 401 because the gate is what sets userId.
const PROTECTED_FN = 'protected-fn';
const OPEN_FN = 'open-fn';

const testUserId = randomUUID();

async function provisionApp(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/init',
    headers: { 'x-test-user-id': testUserId },
    payload: { name: `appkey-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`/init failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().app_id;
}

async function mintKey(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api-keys',
    headers: { 'x-test-user-id': testUserId },
    payload: { name: 'integration-test', ...payload },
  });
}

async function seedFunction(
  appId: string,
  fnName: string,
  auth: 'required' | 'optional' | 'none',
) {
  // Insert app_functions + function_triggers rows directly so the auto-api
  // metaCheck query (apps LEFT JOIN app_functions LEFT JOIN function_triggers)
  // returns `trigger_config.auth='required'` for this function. Bypasses the
  // deploy_function path entirely — too many moving parts (KMS, Deno bundle,
  // etc.) for a control-plane integration test.
  const runtimeDb = await getRuntimeDbForApp(app.controlDb, appId);
  // Migration 018 dropped app_functions.trigger_type / trigger_config — trigger
  // metadata now lives entirely in function_triggers.
  const fnRes = await runtimeDb.query<{ id: string }>(
    `INSERT INTO app_functions (app_id, name, code)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [appId, fnName, 'export default async () => new Response("ok")'],
  );
  let functionId: string;
  if (fnRes.rows.length > 0) {
    functionId = fnRes.rows[0].id;
  } else {
    const existing = await runtimeDb.query<{ id: string }>(
      `SELECT id FROM app_functions WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [appId, fnName],
    );
    functionId = existing.rows[0].id;
  }
  await runtimeDb.query(
    `INSERT INTO function_triggers (function_id, app_id, trigger_type, trigger_config, enabled)
     VALUES ($1, $2, 'http', $3::jsonb, true)
     ON CONFLICT DO NOTHING`,
    [functionId, appId, JSON.stringify({ auth })],
  );
}

beforeAll(async () => {
  app = Fastify();
  await app.register(databasePlugin);
  await app.register(dataPlanePlugin);
  await app.register(runtimeDatabasePlugin);
  await app.register(authPlugin);
  await app.register(initRoutes);
  await app.register(apiKeyRoutes);
  await app.register(autoApiRoutes);
  await app.ready();

  // Seed the platform user. Force plan_id=NULL so /init's plan-limit check
  // short-circuits (the JOIN on plans returns zero rows). The schema default
  // is 'free' / 'playground' which caps to 1 project — fine for prod, fatal
  // for a test that needs two apps.
  await app.controlDb.query(
    `INSERT INTO platform_users (id, cognito_sub, email, plan_id)
     VALUES ($1, $2, $3, NULL)
     ON CONFLICT (id) DO UPDATE SET plan_id = NULL`,
    [testUserId, `test-${testUserId}`, `${testUserId}@test.local`],
  );

  appA = await provisionApp();
  appB = await provisionApp();

  // Seed two functions per app: one protected (auth:required) for the
  // AUTH_REQUIRED case, one open (auth:none) for the impersonation-gate cases.
  await seedFunction(appA, PROTECTED_FN, 'required');
  await seedFunction(appA, OPEN_FN, 'none');
  await seedFunction(appB, OPEN_FN, 'none');

  // Mint one account-scoped key (no target_app_id) and one app-scoped key for A.
  const accountRes = await mintKey({ key_scope: 'account' });
  if (accountRes.statusCode !== 201) {
    throw new Error(`mint account key failed: ${accountRes.statusCode} ${accountRes.body}`);
  }
  accountKey = accountRes.json().key;

  const appARes = await mintKey({ key_scope: 'app', target_app_id: appA });
  if (appARes.statusCode !== 201) {
    throw new Error(`mint app key failed: ${appARes.statusCode} ${appARes.body}`);
  }
  appAKey = appARes.json().key;
}, 30_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('api-keys validator', () => {
  it("400 TARGET_APP_REQUIRED when key_scope='app' without target_app_id", async () => {
    const res = await mintKey({ key_scope: 'app' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('TARGET_APP_REQUIRED');
  });

  it("400 TARGET_APP_NOT_ALLOWED when key_scope='account' with target_app_id", async () => {
    const res = await mintKey({ key_scope: 'account', target_app_id: appA });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('TARGET_APP_NOT_ALLOWED');
  });
});

describe('app-scoped service keys + impersonation gate', () => {
  it('401 AUTH_REQUIRED when an app-scoped key calls auth:required fn without X-Butterbase-As-User', async () => {
    // App-scoped key alone doesn't set userId — the auth:required check fires
    // before the impersonation gate because no asUser header is present.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appA}/fn/${PROTECTED_FN}`,
      headers: { authorization: `Bearer ${appAKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_REQUIRED');
  });

  it('403 AUTH_IMPERSONATION_FORBIDDEN when account-scoped key tries to impersonate', async () => {
    // Account-scoped key has scopes=['*']; callerScope picks the first scope
    // which is '*', not 'app:<appA>'. The exact-match check rejects.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appA}/fn/${OPEN_FN}`,
      headers: {
        authorization: `Bearer ${accountKey}`,
        'x-butterbase-as-user': 'end-user-123',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTH_IMPERSONATION_FORBIDDEN');
  });

  it('403 AUTH_IMPERSONATION_FORBIDDEN when app:A key targets app B', async () => {
    // callerScope is 'app:<appA>', URL is /v1/<appB>/...; exact-match fails.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appB}/fn/${OPEN_FN}`,
      headers: {
        authorization: `Bearer ${appAKey}`,
        'x-butterbase-as-user': 'end-user-123',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTH_IMPERSONATION_FORBIDDEN');
  });

  // TODO(task-6): app-scoped happy-path needs a live Deno runtime at
  // config.runtimeUrl to handle the /execute/<app>/<fn> proxy after the
  // impersonation gate passes. The control-plane test harness deliberately
  // doesn't start a runtime, so we'd have to stand up a stub fetch server.
  // Punt to a follow-up; the negative cases above prove the gate is the only
  // thing standing between callers and the runtime forward.
  it.skip('200 when app:A key with X-Butterbase-As-User calls /v1/A/fn — needs runtime stub', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appA}/fn/${OPEN_FN}`,
      headers: {
        authorization: `Bearer ${appAKey}`,
        'x-butterbase-as-user': 'end-user-123',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });
});
