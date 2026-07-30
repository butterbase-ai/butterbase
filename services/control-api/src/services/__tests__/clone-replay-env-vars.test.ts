import { describe, it, expect } from 'vitest';
import { replayFunctions } from '../clone-replay.js';
import { decrypt, encrypt } from '../crypto.js';
import { runtimeDb, controlDb, seedUser } from '../../__tests__/test-helpers/control-db.js';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

const noopLogger = { info() {}, warn() {} };
const testLogger = noopLogger;

// Single-region test topology: source and dest apps share one physical pool,
// matching the naming used by the appOverrides test cases below (and by
// durable-objects-clone-mint.test.ts's equivalent fixture).
const sourceRuntimePool = runtimeDb;
const destRuntimePool = runtimeDb;

/**
 * Shared fixture for appOverrides tests: seeds an owner + source/dest app
 * pair and the given source functions, each with encrypted_env_vars declaring
 * `envKeys` (placeholder values the override path is expected to replace on
 * the dest). Caller is responsible for calling `cleanupFnFixture`.
 */
async function setupFnCloneFixture(opts: { functions: { name: string; envKeys: string[] }[] }) {
  const { id: ownerId } = await seedUser(
    `replay-fn-ovr-${Date.now()}-${Math.random().toString(36).slice(2)}@x.com`,
  );
  const srcId = `app_fn_ovr_src_${ownerId.slice(0, 8)}`;
  const destId = `app_fn_ovr_dst_${ownerId.slice(0, 8)}`;
  for (const id of [srcId, destId]) {
    await runtimeDb.query(
      `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
       ON CONFLICT (id) DO NOTHING`,
      [id, ownerId],
    );
  }
  for (const fn of opts.functions) {
    const envObj = Object.fromEntries(fn.envKeys.map(k => [k, `placeholder-${k}`]));
    const enc = encrypt(JSON.stringify(envObj), process.env.AUTH_ENCRYPTION_KEY!);
    await runtimeDb.query(
      `INSERT INTO app_functions (id, app_id, name, code, encrypted_env_vars, deployed_by)
       VALUES (gen_random_uuid(), $1, $2, '/* code */', $3, $4)`,
      [srcId, fn.name, enc, ownerId],
    );
  }

  return {
    sourceApp: { id: srcId, owner_id: ownerId },
    destApp: { id: destId, owner_id: ownerId },
  };
}

async function cleanupFnFixture(ownerId: string, srcId: string, destId: string) {
  await runtimeDb.query(`DELETE FROM app_functions WHERE app_id IN ($1, $2)`, [srcId, destId]);
  await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
  await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
  await controlDb.query(`DELETE FROM organizations WHERE owner_id = $1`, [ownerId]);
}

describeDb('replayFunctions with pending env vars', () => {
  it('writes provided values into the dest function encrypted_env_vars', async () => {
    const { id: ownerId } = await seedUser(`replay-env-${Date.now()}@x.com`);
    const srcId = `app_replay_src_${ownerId.slice(0, 8)}`;
    const destId = `app_replay_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerId],
      );
    }
    await runtimeDb.query(
      `INSERT INTO app_functions (id, app_id, name, code, deployed_by)
       VALUES (gen_random_uuid(), $1, 'agent-chat', '/* code */', $2)`,
      [srcId, ownerId],
    );

    const result = await replayFunctions(
      runtimeDb, runtimeDb, srcId, destId, ownerId, noopLogger,
      { pendingEnvVarValues: { 'agent-chat': { OPENAI_KEY: 'sk-user' } } },
    );
    expect(result.warnings).toEqual([]);

    const row = await runtimeDb.query<{ encrypted_env_vars: string | null }>(
      `SELECT encrypted_env_vars FROM app_functions WHERE app_id = $1 AND name = 'agent-chat'`,
      [destId],
    );
    expect(row.rows[0].encrypted_env_vars).not.toBeNull();
    const decoded = JSON.parse(decrypt(row.rows[0].encrypted_env_vars!, process.env.AUTH_ENCRYPTION_KEY!));
    expect(decoded).toEqual({ OPENAI_KEY: 'sk-user' });
    expect(result.unfilledEnvVars).toEqual({});

    await runtimeDb.query(`DELETE FROM app_functions WHERE app_id IN ($1, $2)`, [srcId, destId]);
    await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
    await controlDb.query(`DELETE FROM organizations WHERE owner_id = $1`, [ownerId]);
  });

  it('reports unfilled keys when source has more keys than the user supplied', async () => {
    const { id: ownerId } = await seedUser(`replay-env-unf-${Date.now()}@x.com`);
    const srcId = `app_replay_src_unf_${ownerId.slice(0, 8)}`;
    const destId = `app_replay_dst_unf_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerId],
      );
    }
    const { encrypt } = await import('../crypto.js');
    const enc = encrypt(
      JSON.stringify({ OPENAI_KEY: 'sk-src', ANTHROPIC_KEY: 'sk-ant' }),
      process.env.AUTH_ENCRYPTION_KEY!,
    );
    await runtimeDb.query(
      `INSERT INTO app_functions (id, app_id, name, code, encrypted_env_vars, deployed_by)
       VALUES (gen_random_uuid(), $1, 'agent-chat', '/* code */', $2, $3)`,
      [srcId, enc, ownerId],
    );

    const result = await replayFunctions(
      runtimeDb, runtimeDb, srcId, destId, ownerId, noopLogger,
      { pendingEnvVarValues: { 'agent-chat': { OPENAI_KEY: 'sk-user' } } },
    );
    expect(result.unfilledEnvVars).toEqual({ 'agent-chat': ['ANTHROPIC_KEY'] });

    await runtimeDb.query(`DELETE FROM app_functions WHERE app_id IN ($1, $2)`, [srcId, destId]);
    await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
    await controlDb.query(`DELETE FROM organizations WHERE owner_id = $1`, [ownerId]);
  });

  // Phase 4 contract: one shared bb_sk_* per clone, fanned out to every fn
  // that needs BUTTERBASE_API_KEY. Pre-Phase-4 the clone job minted a distinct
  // key per function, which broke any in-app function-to-function call whose
  // callee compared the bearer to its own env. See
  // backfill-consolidate-clone-keys.ts for the matching cleanup script.
  it('mints exactly one shared bb_sk_* and assigns the same value to every fn', async () => {
    const { id: ownerId } = await seedUser(`replay-shared-${Date.now()}@x.com`);
    const srcId = `app_replay_shared_src_${ownerId.slice(0, 8)}`;
    const destId = `app_replay_shared_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerId],
      );
    }
    const { encrypt } = await import('../crypto.js');
    const enc = encrypt(
      JSON.stringify({ BUTTERBASE_API_KEY: 'placeholder' }),
      process.env.AUTH_ENCRYPTION_KEY!,
    );
    for (const fn of ['auto-sync', 'ingest-gmail', 'ingest-calendar']) {
      await runtimeDb.query(
        `INSERT INTO app_functions (id, app_id, name, code, encrypted_env_vars, deployed_by)
         VALUES (gen_random_uuid(), $1, $2, '/* code */', $3, $4)`,
        [srcId, fn, enc, ownerId],
      );
    }

    const result = await replayFunctions(
      runtimeDb, runtimeDb, srcId, destId, ownerId, noopLogger,
      { controlPool: controlDb, destAppOwnerId: ownerId },
    );
    expect(result.warnings).toEqual([]);
    expect(result.unfilledEnvVars).toEqual({});

    const rows = await runtimeDb.query<{ name: string; encrypted_env_vars: string }>(
      `SELECT name, encrypted_env_vars FROM app_functions WHERE app_id = $1 ORDER BY name`,
      [destId],
    );
    const distinctKeys = new Set<string>();
    for (const r of rows.rows) {
      const env = JSON.parse(decrypt(r.encrypted_env_vars, process.env.AUTH_ENCRYPTION_KEY!));
      expect(typeof env.BUTTERBASE_API_KEY).toBe('string');
      expect(env.BUTTERBASE_API_KEY.startsWith('bb_sk_')).toBe(true);
      distinctKeys.add(env.BUTTERBASE_API_KEY);
    }
    expect(distinctKeys.size).toBe(1);

    const keyRows = await controlDb.query<{ name: string }>(
      `SELECT name FROM api_keys WHERE user_id = $1 AND name LIKE $2`,
      [ownerId, `Auto-mint for clone (${destId})%`],
    );
    // Exactly ONE auto-minted key for this clone — no per-fn proliferation.
    expect(keyRows.rows.length).toBe(1);
    expect(keyRows.rows[0].name).toBe(`Auto-mint for clone (${destId})`);

    await controlDb.query(`DELETE FROM api_keys WHERE user_id = $1`, [ownerId]);
    await runtimeDb.query(`DELETE FROM app_functions WHERE app_id IN ($1, $2)`, [srcId, destId]);
    await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
    await controlDb.query(`DELETE FROM organizations WHERE owner_id = $1`, [ownerId]);
  });

  it('layers appOverrides into a function that declares the key', async () => {
    const { sourceApp, destApp } = await setupFnCloneFixture({
      functions: [{ name: 'fn_a', envKeys: ['MY_SECRET'] }],
    });

    const result = await replayFunctions(
      sourceRuntimePool,
      destRuntimePool,
      sourceApp.id,
      destApp.id,
      destApp.owner_id,
      testLogger,
      { appOverrides: { MY_SECRET: 'v-from-override' } },
    );

    expect(result.overrideFilledFunctions.fn_a).toContain('MY_SECRET');
    const encKey = process.env.AUTH_ENCRYPTION_KEY!;
    const row = await destRuntimePool.query<{ encrypted_env_vars: string }>(
      `SELECT encrypted_env_vars FROM app_functions WHERE app_id = $1 AND name = 'fn_a'`,
      [destApp.id],
    );
    const decoded = JSON.parse(decrypt(row.rows[0].encrypted_env_vars, encKey));
    expect(decoded.MY_SECRET).toEqual('v-from-override');
    expect(result.unfilledEnvVars.fn_a ?? []).not.toContain('MY_SECRET');

    await cleanupFnFixture(destApp.owner_id, sourceApp.id, destApp.id);
  });

  it('user-supplied pendingEnvVarValues wins over appOverrides', async () => {
    const { sourceApp, destApp } = await setupFnCloneFixture({
      functions: [{ name: 'fn_a', envKeys: ['MY_SECRET'] }],
    });

    const result = await replayFunctions(
      sourceRuntimePool,
      destRuntimePool,
      sourceApp.id,
      destApp.id,
      destApp.owner_id,
      testLogger,
      {
        pendingEnvVarValues: { fn_a: { MY_SECRET: 'user-value' } },
        appOverrides: { MY_SECRET: 'override-value' },
      },
    );

    expect(result.overrideFilledFunctions.fn_a ?? []).not.toContain('MY_SECRET');
    const decoded = JSON.parse(
      decrypt(
        (await destRuntimePool.query<{ encrypted_env_vars: string }>(
          `SELECT encrypted_env_vars FROM app_functions WHERE app_id = $1 AND name = 'fn_a'`,
          [destApp.id],
        )).rows[0].encrypted_env_vars,
        process.env.AUTH_ENCRYPTION_KEY!,
      ),
    );
    expect(decoded.MY_SECRET).toEqual('user-value');

    await cleanupFnFixture(destApp.owner_id, sourceApp.id, destApp.id);
  });

  it('shares the same override value across every function that declares it', async () => {
    const { sourceApp, destApp } = await setupFnCloneFixture({
      functions: [
        { name: 'fn_a', envKeys: ['SHARED_SECRET'] },
        { name: 'fn_b', envKeys: ['SHARED_SECRET'] },
      ],
    });
    const sharedValue = 'ab'.repeat(32);
    const result = await replayFunctions(
      sourceRuntimePool,
      destRuntimePool,
      sourceApp.id,
      destApp.id,
      destApp.owner_id,
      testLogger,
      { appOverrides: { SHARED_SECRET: sharedValue } },
    );
    expect(result.overrideFilledFunctions.fn_a).toContain('SHARED_SECRET');
    expect(result.overrideFilledFunctions.fn_b).toContain('SHARED_SECRET');
    const encKey = process.env.AUTH_ENCRYPTION_KEY!;
    for (const name of ['fn_a', 'fn_b']) {
      const row = await destRuntimePool.query<{ encrypted_env_vars: string }>(
        `SELECT encrypted_env_vars FROM app_functions WHERE app_id = $1 AND name = $2`,
        [destApp.id, name],
      );
      const decoded = JSON.parse(decrypt(row.rows[0].encrypted_env_vars, encKey));
      expect(decoded.SHARED_SECRET).toEqual(sharedValue);
    }

    await cleanupFnFixture(destApp.owner_id, sourceApp.id, destApp.id);
  });
});
