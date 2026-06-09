import { describe, it, expect, beforeEach } from 'vitest';
import { listSourceEnvVarKeys } from '../clone-env-vars.js';
import { encrypt } from '../crypto.js';
import { runtimeDb } from '../../__tests__/test-helpers/control-db.js';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

describeDb('listSourceEnvVarKeys', () => {
  beforeEach(async () => {
    await runtimeDb.query("DELETE FROM app_functions WHERE app_id LIKE 'app_clone_env_test_%'");
    await runtimeDb.query("DELETE FROM apps WHERE id LIKE 'app_clone_env_test_%'");
  });

  it('returns per-function key names from encrypted_env_vars', async () => {
    const appId = 'app_clone_env_test_src';
    const ownerId = '00000000-0000-0000-0000-000000000001';
    await runtimeDb.query(
      `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, 'src', $2, $1, 'us-east-1')
       ON CONFLICT (id) DO NOTHING`,
      [appId, ownerId],
    );
    const enc = encrypt(
      JSON.stringify({ BUTTERBASE_API_KEY: 'bb_sk_xxx', OPENAI_KEY: 'sk-xxx' }),
      process.env.AUTH_ENCRYPTION_KEY!,
    );
    await runtimeDb.query(
      `INSERT INTO app_functions (id, app_id, name, code, encrypted_env_vars, deployed_by)
       VALUES (gen_random_uuid(), $1, 'agent-chat', '/* code */', $2, $3)`,
      [appId, enc, ownerId],
    );

    const result = await listSourceEnvVarKeys(runtimeDb, appId);
    expect(result).toEqual([
      { fn_name: 'agent-chat', keys: expect.arrayContaining(['BUTTERBASE_API_KEY', 'OPENAI_KEY']) },
    ]);
  });

  it('returns an empty list for a function with no encrypted_env_vars', async () => {
    const appId = 'app_clone_env_test_empty';
    const ownerId = '00000000-0000-0000-0000-000000000001';
    await runtimeDb.query(
      `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, 'empty', $2, $1, 'us-east-1')
       ON CONFLICT (id) DO NOTHING`,
      [appId, ownerId],
    );
    await runtimeDb.query(
      `INSERT INTO app_functions (id, app_id, name, code, deployed_by)
       VALUES (gen_random_uuid(), $1, 'noop', '/* code */', $2)`,
      [appId, ownerId],
    );
    expect(await listSourceEnvVarKeys(runtimeDb, appId)).toEqual([]);
  });
});
