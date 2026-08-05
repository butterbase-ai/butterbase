import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { setOperatorCredential, getOperatorCredential } from '../operator-credential.js';

process.env.OPERATOR_CRED_KEY = 'a'.repeat(64);

const ORG = 'org-cred-test';
const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

beforeEach(async () => {
  await pool.query(`DELETE FROM dashboard_agent_operator_credentials WHERE organization_id=$1`, [ORG]);
});
afterAll(async () => { await pool.end(); });

describe('operator credential', () => {
  it('round-trips a service key', async () => {
    await setOperatorCredential(pool, ORG, 'bb_sk_example_123');
    expect(await getOperatorCredential(pool, ORG)).toBe('bb_sk_example_123');
  });

  it('returns null when absent', async () => {
    expect(await getOperatorCredential(pool, 'org-nonexistent')).toBeNull();
  });

  it('does not store the key in plaintext', async () => {
    await setOperatorCredential(pool, ORG, 'bb_sk_secret_value');
    const r = await pool.query(
      `SELECT ciphertext FROM dashboard_agent_operator_credentials WHERE organization_id=$1`, [ORG]
    );
    expect(r.rows[0].ciphertext).not.toContain('bb_sk_secret_value');
  });

  it('overwrites on re-set', async () => {
    await setOperatorCredential(pool, ORG, 'first');
    await setOperatorCredential(pool, ORG, 'second');
    expect(await getOperatorCredential(pool, ORG)).toBe('second');
  });
});
