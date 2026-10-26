// Actual current loader/cache control flow; PostgreSQL is replaced by the test
// import map. This is not real-DB paused-app integration proof.
import { strict as assert } from 'node:assert';
import { loadFunction, invalidateCache, AppPausedError } from '../function-loader.ts';
import { setQueryHandler, queries } from './fixtures/capture-postgres.ts';

Deno.test('current paused-app gates survive runtime byte/header changes (offline DB boundary)', async t => {
  const app = 'app_paused_offline', deployed_at = new Date('2026-01-01T00:00:00Z');
  let paused = false, deleted = false;
  setQueryHandler((sql, args) => {
    assert.equal(args[0], app);
    if (sql.includes('SELECT f.deployed_at')) return { rows: deleted ? [] : [{ deployed_at, paused }], rowCount: deleted ? 0 : 1 };
    if (sql.includes('f.id, f.app_id')) return { rows: [{ id: 'fn_paused_offline', app_id: app, name: args[1], code: 'const handler = () => new Response("ok")',
      encrypted_env_vars: null, app_encrypted_env_vars: null, timeout_ms: 5000, memory_limit_mb: 128, deployed_at }], rowCount: 1 };
    if (sql.includes('FROM apps WHERE id')) return { rows: [{ db_provisioned: true, name: 'offline', owner_id: 'synthetic-owner', region: 'test', anon_key: 'synthetic-anon', paused }], rowCount: 1 };
    if (sql.includes('FROM app_db_connections')) return { rows: [{ connection_string: 'postgres://unused/unused' }], rowCount: 1 };
    throw new Error('Unexpected fixture SQL');
  });
  try {
    await t.step('running app loads then paused cache hit rejects', async () => {
      assert.ok(await loadFunction(app, 'cached'));
      paused = true;
      await assert.rejects(() => loadFunction(app, 'cached'), AppPausedError);
    });
    await t.step('paused cache miss rejects before metadata is cached', async () => {
      await assert.rejects(() => loadFunction(app, 'uncached'), AppPausedError);
    });
    await t.step('resumed app loads on both cached and uncached paths', async () => {
      paused = false;
      assert.ok(await loadFunction(app, 'cached'));
      assert.ok(await loadFunction(app, 'uncached'));
    });
    await t.step('deleted cached function stays absent', async () => {
      deleted = true;
      assert.equal(await loadFunction(app, 'cached'), null);
    });
    assert(queries.length > 0);
  } finally {
    setQueryHandler(undefined);
    invalidateCache(app, 'cached'); invalidateCache(app, 'uncached');
  }
});
