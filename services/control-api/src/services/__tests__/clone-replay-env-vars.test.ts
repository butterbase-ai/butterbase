import { describe, it, expect } from 'vitest';
import { replayFunctions } from '../clone-replay.js';
import { decrypt } from '../crypto.js';
import { runtimeDb, controlDb } from '../../__tests__/test-helpers/control-db.js';
import { randomUUID } from 'node:crypto';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

const noopLogger = { info() {}, warn() {} };

describeDb('replayFunctions with pending env vars', () => {
  it('writes provided values into the dest function encrypted_env_vars', async () => {
    const ownerId = randomUUID();
    await controlDb.query(
      `INSERT INTO platform_users (id, email, email_verified) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING`,
      [ownerId, `replay-env-${ownerId}@x.com`],
    );
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
  });

  it('reports unfilled keys when source has more keys than the user supplied', async () => {
    const ownerId = randomUUID();
    await controlDb.query(
      `INSERT INTO platform_users (id, email, email_verified) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING`,
      [ownerId, `replay-env-unf-${ownerId}@x.com`],
    );
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
  });
});
