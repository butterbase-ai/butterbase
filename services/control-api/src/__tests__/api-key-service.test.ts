import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import { ApiKeyService } from '../services/api-key-service.js';
import { API_KEY_PREFIX } from '@butterbase/shared/constants';
import { config } from '../config.js';

describe('ApiKeyService', () => {
  let pool: pg.Pool;
  let testUserId: string;
  let testOrgId: string;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: config.controlDb.url,
    });

    // Create test user with a personal org — randomize email/sub so a previous
    // crashed run (afterAll didn't fire) doesn't poison subsequent runs via
    // the unique constraint on platform_users.email.
    const suffix = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tmpId = crypto.randomUUID();
      const orgResult = await client.query<{ id: string }>(
        `INSERT INTO organizations (owner_id, name, personal, plan_id, credits_usd, auto_refill_enabled, account_status)
         VALUES ($1, 'test org', true, 'playground', 0, false, 'active')
         RETURNING id`,
        [tmpId],
      );
      testOrgId = orgResult.rows[0].id;
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO platform_users (id, email, cognito_sub, personal_organization_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [tmpId, `apikey-test-${suffix}@example.com`, `apikey-test-sub-${suffix}`, testOrgId],
      );
      testUserId = userResult.rows[0].id;
      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role, joined_at)
         VALUES ($1, $2, 'owner', now())
         ON CONFLICT DO NOTHING`,
        [testOrgId, testUserId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM platform_users WHERE id = $1', [testUserId]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [testOrgId]);
    await pool.end();
  });

  it('generates key with correct prefix and length', async () => {
    const { key, prefix } = await ApiKeyService.generateApiKey(
      pool,
      testUserId,
      'Test Key'
    );

    expect(key).toMatch(new RegExp(`^${API_KEY_PREFIX}[a-f0-9]{40}$`));
    expect(prefix).toBe(key.substring(0, 12));
  });

  it('validates correct key and returns auth context', async () => {
    const { key } = await ApiKeyService.generateApiKey(
      pool,
      testUserId,
      'Valid Key'
    );

    const authContext = await ApiKeyService.validateApiKey(pool, key);

    expect(authContext).not.toBeNull();
    expect(authContext?.userId).toBe(testUserId);
    expect(authContext?.authMethod).toBe('api_key');
    expect(authContext?.scopes).toEqual(['*']);
  });

  it('returns null for invalid key', async () => {
    const authContext = await ApiKeyService.validateApiKey(
      pool,
      'bb_sk_invalid1234567890123456789012345678'
    );

    expect(authContext).toBeNull();
  });

  it('returns null for revoked key', async () => {
    const { key, keyId } = await ApiKeyService.generateApiKey(
      pool,
      testUserId,
      'Revoked Key'
    );

    await ApiKeyService.revokeKey(pool, keyId, testUserId);

    const authContext = await ApiKeyService.validateApiKey(pool, key);
    expect(authContext).toBeNull();
  });

  it('list keys never includes hash', async () => {
    await ApiKeyService.generateApiKey(pool, testUserId, 'List Test');

    const keys = await ApiKeyService.listKeys(pool, testOrgId);

    expect(keys.length).toBeGreaterThan(0);
    keys.forEach((key: any) => {
      expect(key).not.toHaveProperty('key_hash');
      expect(key.key_prefix).toBeDefined();
    });
  });

  it('revoke checks ownership', async () => {
    const { keyId } = await ApiKeyService.generateApiKey(
      pool,
      testUserId,
      'Ownership Test'
    );

    // Try to revoke with wrong user ID
    const result = await ApiKeyService.revokeKey(
      pool,
      keyId,
      '00000000-0000-0000-0000-000000000000'
    );

    expect(result).toBe(false);
  });

  describe("generateApiKey with scope='both'", () => {
    let bothUserId: string;

    beforeAll(async () => {
      const result = await pool.query(
        `INSERT INTO platform_users (email, cognito_sub)
         VALUES ('plan-test-both@example.test', 'both-sub')
         RETURNING id`
      );
      bothUserId = result.rows[0].id;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM platform_users WHERE id = $1', [bothUserId]);
    });

    it("mints a bb_sk_-prefixed key, sets scope=both, and sets substrate_user_id=user_id", async () => {
      const result = await ApiKeyService.generateApiKey(
        pool, bothUserId, 'combined key', ['*'], 'both'
      );

      expect(result.key.startsWith('bb_sk_')).toBe(true);

      const row = (await pool.query(
        `SELECT scope, substrate_user_id, user_id FROM api_keys WHERE id = $1`,
        [result.keyId]
      )).rows[0];

      expect(row.scope).toBe('both');
      expect(row.substrate_user_id).toBe(bothUserId);
      expect(row.user_id).toBe(bothUserId);
    });

    it("regression guard: 'both' always sets substrate_user_id=userId", async () => {
      const guardResult = await pool.query(
        `INSERT INTO platform_users (email, cognito_sub)
         VALUES ('plan-test-both-guard@example.test', 'both-guard-sub')
         RETURNING id`
      );
      const guardUserId = guardResult.rows[0].id;

      try {
        const result = await ApiKeyService.generateApiKey(
          pool, guardUserId, 'guard key', ['*'], 'both'
        );
        const row = (await pool.query(
          `SELECT substrate_user_id FROM api_keys WHERE id = $1`, [result.keyId]
        )).rows[0];
        expect(row.substrate_user_id).toBe(guardUserId);
      } finally {
        await pool.query('DELETE FROM platform_users WHERE id = $1', [guardUserId]);
      }
    });
  });

  describe('listKeys scope filter', () => {
    let scopeUserId: string;
    let scopeOrgId: string;

    async function seedKey(scope: 'app' | 'substrate', substrateUserId: string | null) {
      const hash = crypto.randomBytes(20).toString('hex');
      await pool.query(
        `INSERT INTO api_keys (user_id, organization_id, key_hash, key_prefix, name, scopes, scope, substrate_user_id)
         VALUES ($1, $2, $3, 'bb_sk_xxx12', 'test', $4, $5, $6)`,
        [scopeUserId, scopeOrgId, hash, ['*'], scope, substrateUserId]
      );
    }

    beforeAll(async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tmpId = crypto.randomUUID();
        const orgResult = await client.query<{ id: string }>(
          `INSERT INTO organizations (owner_id, name, personal, plan_id, credits_usd, auto_refill_enabled, account_status)
           VALUES ($1, 'scope-test org', true, 'playground', 0, false, 'active')
           RETURNING id`,
          [tmpId],
        );
        scopeOrgId = orgResult.rows[0].id;
        const userResult = await client.query<{ id: string }>(
          `INSERT INTO platform_users (id, email, cognito_sub, personal_organization_id)
           VALUES ($1, 'scope-test@example.com', 'scope-test-sub', $2)
           RETURNING id`,
          [tmpId, scopeOrgId],
        );
        scopeUserId = userResult.rows[0].id;
        await client.query(
          `INSERT INTO organization_members (organization_id, user_id, role, joined_at)
           VALUES ($1, $2, 'owner', now()) ON CONFLICT DO NOTHING`,
          [scopeOrgId, scopeUserId],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    });

    afterAll(async () => {
      await pool.query('DELETE FROM platform_users WHERE id = $1', [scopeUserId]);
      await pool.query('DELETE FROM organizations WHERE id = $1', [scopeOrgId]);
    });

    beforeEach(async () => {
      await pool.query('DELETE FROM api_keys WHERE user_id = $1', [scopeUserId]);
    });

    it('listKeys with no scope returns all non-revoked keys for the org (with scope field)', async () => {
      // migration 073: substrate_user_id must equal user_id for substrate keys
      await seedKey('substrate', scopeUserId);
      await seedKey('app', scopeUserId);
      const result = await ApiKeyService.listKeys(pool, scopeOrgId);
      expect(result).toHaveLength(2);
      expect(result.map((k: any) => k.scope).sort()).toEqual(['app', 'substrate']);
    });

    it('listKeys with scope=substrate returns only substrate keys', async () => {
      await seedKey('substrate', scopeUserId);
      await seedKey('app', scopeUserId);
      const result = await ApiKeyService.listKeys(pool, scopeOrgId, 'substrate');
      expect(result).toHaveLength(1);
      expect(result.every((k: any) => k.scope === 'substrate')).toBe(true);
    });

    it('listKeys with scope=app returns only app keys', async () => {
      await seedKey('substrate', scopeUserId);
      await seedKey('app', scopeUserId);
      const result = await ApiKeyService.listKeys(pool, scopeOrgId, 'app');
      expect(result).toHaveLength(1);
      expect(result.every((k: any) => k.scope === 'app')).toBe(true);
    });
  });
});
