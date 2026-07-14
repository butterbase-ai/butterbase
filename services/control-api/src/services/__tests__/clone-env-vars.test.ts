import { describe, it, expect, beforeEach } from 'vitest';
import { listSourceEnvVarKeys, detectConventions, mintApiKeyForClone, resolveStaticFills, AUTO_MINT_CONVENTION_KEYS, STATIC_FILL_KEYS } from '../clone-env-vars.js';
import { encrypt } from '../crypto.js';
import { runtimeDb, controlDb, seedUser } from '../../__tests__/test-helpers/control-db.js';

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

describe('detectConventions', () => {
  it('flags BUTTERBASE_API_KEY and BB_SUBSTRATE_KEY as auto-mintable', () => {
    expect(detectConventions(['BUTTERBASE_API_KEY', 'BB_SUBSTRATE_KEY', 'OPENAI_KEY'])).toEqual([
      { key: 'BUTTERBASE_API_KEY', convention: 'butterbase_api_key', auto_mintable: true },
      { key: 'BB_SUBSTRATE_KEY', convention: 'butterbase_api_key', auto_mintable: true },
    ]);
  });

  it('returns empty when no known conventions match', () => {
    expect(detectConventions(['OPENAI_KEY', 'STRIPE_SECRET'])).toEqual([]);
  });

  it('AUTO_MINT_CONVENTION_KEYS covers both BUTTERBASE_API_KEY and BB_SUBSTRATE_KEY', () => {
    expect(AUTO_MINT_CONVENTION_KEYS).toEqual(
      expect.arrayContaining(['BUTTERBASE_API_KEY', 'BB_SUBSTRATE_KEY']),
    );
  });
});

describe('resolveStaticFills', () => {
  it('returns BUTTERBASE_API_URL from apiBaseUrl and BUTTERBASE_APP_ID from destAppId', () => {
    expect(resolveStaticFills({ destAppId: 'app_xyz', apiBaseUrl: 'https://api.example.com' })).toEqual({
      BUTTERBASE_API_URL: 'https://api.example.com',
      BUTTERBASE_APP_ID: 'app_xyz',
    });
  });

  it('STATIC_FILL_KEYS matches resolveStaticFills output', () => {
    const fills = resolveStaticFills({ destAppId: 'app_xyz', apiBaseUrl: 'https://x' });
    expect(STATIC_FILL_KEYS).toEqual(expect.arrayContaining(Object.keys(fills)));
    expect(Object.keys(fills).length).toBe(STATIC_FILL_KEYS.length);
  });
});

describeDb('mintApiKeyForClone', () => {
  it('mints a bb_sk_* key scoped to the dest app and owner', async () => {
    // Seed a platform_users row (with the required personal_organization_id
    // populated) via the shared helper — a plain INSERT would violate the
    // NOT NULL FK constraint on platform_users.personal_organization_id.
    const { id: ownerId } = await seedUser(`auto-mint-test-${Date.now()}@x.com`);

    const destAppId = `app_dest_mint_test_${ownerId.slice(0, 8)}`;
    const { key, keyId } = await mintApiKeyForClone(controlDb, {
      ownerId,
      destAppId,
    });
    expect(key.startsWith('bb_sk_')).toBe(true);

    const row = await controlDb.query<{ scopes: string[]; name: string; user_id: string }>(
      `SELECT scopes, name, user_id FROM api_keys WHERE id = $1`,
      [keyId],
    );
    expect(row.rows[0].user_id).toBe(ownerId);
    expect(row.rows[0].scopes).toEqual(expect.arrayContaining([`app:${destAppId}`, 'ai:gateway']));
    // Per Phase 4: the auto-minted key is one-per-app, NOT one-per-function —
    // function name is intentionally absent from the label so all functions on
    // a cloned app share one credential.
    expect(row.rows[0].name).toBe(`Auto-mint for clone (${destAppId})`);

    await controlDb.query(`DELETE FROM api_keys WHERE id = $1`, [keyId]);
    // platform_users first (FK: user.personal_organization_id → orgs.id),
    // organizations second — reverse of seedUser's insert order.
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
    await controlDb.query(`DELETE FROM organizations WHERE owner_id = $1`, [ownerId]);
  });
});
