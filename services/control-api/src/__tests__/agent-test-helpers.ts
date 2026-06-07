// Shared test fixtures for the agent route tests.
//
// The salvaged tests were written when agents lived in control-plane and
// /init created an app row in that same pool. After the runtime-plane move
// (plan §6 Phase 2), agent_* + apps live in runtime-plane. To avoid a hard
// dependency on the full /init provisioning pipeline, this helper:
//
//   1. Opens a real runtime-plane pool (the same DB the live container hits)
//   2. Mocks the databasePlugin so app.controlDb IS the runtime pool — tests
//      get to keep their existing `await app.controlDb.query(...)` calls for
//      seeding fixtures and verifying side effects
//   3. Mocks region-resolver.getRuntimeDbForApp to return the same pool —
//      routes resolve "the runtime pool for app X" to the test's seed pool
//   4. Seeds a deterministic apps row owned by TEST_USER_ID
//
// vi.mock calls in this file are hoisted, so `import` consumers should
// re-export from here rather than vi.mock the modules in each test file.

import pg from 'pg';
import { vi } from 'vitest';

export const TEST_USER_ID = '00000000-0000-0000-0000-000000000099';

const RUNTIME_DSN =
  process.env.TEST_RUNTIME_DB_URL ??
  process.env.CONTROL_PLANE_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let _pool: pg.Pool | null = null;
export function getTestPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: RUNTIME_DSN, max: 5 });
  }
  return _pool;
}

export async function closeTestPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Insert an apps row (idempotent) so route ownership checks succeed.
 * Returns the appId.
 */
export async function seedTestApp(opts: {
  appId?: string;
  ownerId?: string;
  prefix?: string;
} = {}): Promise<string> {
  const pool = getTestPool();
  const appId = opts.appId ?? `app_test_${Math.random().toString(36).slice(2, 10)}`;
  const ownerId = opts.ownerId ?? TEST_USER_ID;
  const dbName = `${opts.prefix ?? 'agent_test'}_${Math.random().toString(36).slice(2, 8)}`;

  await pool.query(
    `INSERT INTO apps
       (id, owner_id, name, db_name, region, provisioning_status, deployment_backend, access_mode)
     VALUES ($1, $2, $3, $4, 'us-east-1', 'ready', 'pages', 'public')
     ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id`,
    [appId, ownerId, opts.prefix ?? 'agent-test', dbName],
  );
  return appId;
}

/** Best-effort cleanup of test-created rows for one app. */
export async function cleanupTestApp(appId: string): Promise<void> {
  const pool = getTestPool();
  // Order matters for FK cascade-clean: child rows first.
  await pool.query(`DELETE FROM agent_run_events WHERE run_id IN (SELECT id FROM agent_runs WHERE app_id=$1)`, [appId]);
  await pool.query(`DELETE FROM agent_webhook_deliveries WHERE run_id IN (SELECT id FROM agent_runs WHERE app_id=$1)`, [appId]);
  await pool.query(`DELETE FROM agent_checkpoints WHERE run_id IN (SELECT id FROM agent_runs WHERE app_id=$1)`, [appId]);
  await pool.query(`DELETE FROM agent_usage WHERE run_id IN (SELECT id FROM agent_runs WHERE app_id=$1)`, [appId]);
  await pool.query(`DELETE FROM agent_tool_audits WHERE app_id=$1`, [appId]);
  await pool.query(`DELETE FROM agent_runs WHERE app_id=$1`, [appId]);
  await pool.query(`DELETE FROM agent_mcp_servers WHERE app_id=$1`, [appId]);
  await pool.query(`DELETE FROM agents WHERE app_id=$1`, [appId]);
  await pool.query(`DELETE FROM apps WHERE id=$1`, [appId]);
}

/**
 * Install the database + region-resolver mocks. Call from the module's top
 * level — vi.mock is hoisted, so the mocks apply before routes are imported.
 *
 * Tests should then `import { databasePlugin } from '../plugins/database.js'`
 * and `app.register(databasePlugin)` as normal — the mock will install the
 * runtime pool as app.controlDb.
 */
export function installAgentTestMocks(): void {
  vi.mock('../plugins/database.js', async () => {
    const fp = (await import('fastify-plugin')).default;
    return {
      databasePlugin: fp(async (fastify: any) => {
        // fastify-plugin escapes the encapsulation context so app.controlDb
        // is visible from tests (which access it directly to verify side
        // effects). Without fp(), the decorate scope wouldn't leak past
        // register() and `app.controlDb` would be undefined in `it()` blocks.
        fastify.decorate('controlDb', getTestPool());
      }),
    };
  });
  vi.mock('../services/region-resolver.js', async () => {
    return {
      getRuntimeDbForApp: vi.fn(async (_controlPool: any, _appId: string) => {
        return getTestPool();
      }),
    };
  });
}
