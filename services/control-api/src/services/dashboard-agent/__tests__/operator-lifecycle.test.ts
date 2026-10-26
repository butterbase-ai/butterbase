import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { provisionOperatorInTransaction } from '../operator-lifecycle.js';

const priorKey = process.env.OPERATOR_CRED_KEY;
afterEach(() => {
  if (priorKey === undefined) delete process.env.OPERATOR_CRED_KEY;
  else process.env.OPERATOR_CRED_KEY = priorKey;
});

describe('provisionOperatorInTransaction', () => {
  it('writes the locked key, encrypted credential and due sweep through only the supplied client', async () => {
    process.env.OPERATOR_CRED_KEY = 'a'.repeat(64);
    const writes: { sql: string; args: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, args: unknown[]) => {
        writes.push({ sql, args });
        return { rows: [{ id: 'key-id', name: 'Office operator' }] };
      }),
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network call inside transaction');
    });
    const now = new Date('2026-10-26T10:00:00.000Z');
    try {
      expect(await provisionOperatorInTransaction(client as never, {
        organizationId: 'org-one', userId: 'user-one',
        instructions: 'Review recent records.', intervalSeconds: 600, now,
      })).toEqual({ keyId: 'key-id' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }

    expect(writes).toHaveLength(3);
    expect(writes[0].sql).toContain('INSERT INTO api_keys');
    expect(writes[0].sql).toContain('organization_locked');
    expect(writes[0].args).toContain(true);
    expect(writes[0].args).toContain('org-one');
    expect(writes[1].sql).toContain('INSERT INTO dashboard_agent_operator_credentials');
    const ciphertext = writes[1].args[1] as string;
    expect(ciphertext).not.toContain('bb_sk_');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from('a'.repeat(64), 'hex'), Buffer.from(writes[1].args[2] as string, 'base64'));
    decipher.setAAD(Buffer.from('org-one'));
    decipher.setAuthTag(Buffer.from(writes[1].args[3] as string, 'base64'));
    const key = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
    expect(key).toMatch(/^bb_sk_[a-f0-9]{40}$/);
    expect(writes[0].args[2]).toBe(crypto.createHash('sha256').update(key).digest('hex'));
    expect(writes[2].sql).toContain('INSERT INTO dashboard_agent_operator_jobs');
    expect(writes[2].args).toEqual(['org-one', 'sweep', 'Review recent records.', 600, now]);
    expect(JSON.stringify(writes)).not.toContain(key);
  });

  it('rejects malformed hex before making any write', async () => {
    process.env.OPERATOR_CRED_KEY = 'z'.repeat(64);
    const client = { query: vi.fn() };
    await expect(provisionOperatorInTransaction(client as never, {
      organizationId: 'org-one', userId: 'user-one',
      instructions: 'Review', intervalSeconds: 600, now: new Date(),
    })).rejects.toThrow('OPERATOR_CRED_KEY');
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe.runIf(Boolean(process.env.CONTROL_TEST_DATABASE_URL))('provisioning transaction rollback', () => {
  it('leaves no key, credential or job when its caller rolls back', async () => {
    process.env.OPERATOR_CRED_KEY = 'b'.repeat(64);
    const pool = new pg.Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });
    const userId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    let keyId: string | undefined;
    try {
      await pool.query(
        `INSERT INTO organizations (id, owner_id, name, personal, plan_id, credits_usd, auto_refill_enabled, account_status)
         VALUES ($1, $2, 'Operator transaction test', true, 'playground', 0, false, 'active')`,
        [organizationId, userId],
      );
      await pool.query(
        `INSERT INTO platform_users (id, email, cognito_sub, personal_organization_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, `operator-lifecycle-${userId}@example.invalid`, `operator-lifecycle-${userId}`, organizationId],
      );
      await pool.query(
        `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [organizationId, userId],
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await provisionOperatorInTransaction(client, {
          organizationId, userId, instructions: 'Review recent records.',
          intervalSeconds: 600, now: new Date('2026-10-26T10:00:00Z'),
        });
        keyId = result.keyId;
        const inTransaction = await client.query(
          `SELECT organization_locked FROM api_keys WHERE id=$1`, [keyId],
        );
        expect(inTransaction.rows[0].organization_locked).toBe(true);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      expect((await pool.query(`SELECT id FROM api_keys WHERE id=$1`, [keyId])).rows).toHaveLength(0);
      expect((await pool.query(
        `SELECT organization_id FROM dashboard_agent_operator_credentials WHERE organization_id=$1`, [organizationId],
      )).rows).toHaveLength(0);
      expect((await pool.query(
        `SELECT organization_id FROM dashboard_agent_operator_jobs WHERE organization_id=$1`, [organizationId],
      )).rows).toHaveLength(0);
    } finally {
      await pool.query('DELETE FROM platform_users WHERE id=$1', [userId]);
      await pool.query('DELETE FROM organizations WHERE id=$1', [organizationId]);
      await pool.end();
    }
  });
});
