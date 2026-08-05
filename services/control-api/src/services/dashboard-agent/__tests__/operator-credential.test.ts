import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { setOperatorCredential, getOperatorCredential } from '../operator-credential.js';

process.env.OPERATOR_CRED_KEY = 'a'.repeat(64);

const ORG = 'org-cred-test';
const OTHER_ORG = 'org-cred-test-other';
const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

beforeEach(async () => {
  await pool.query(
    `DELETE FROM dashboard_agent_operator_credentials WHERE organization_id = ANY($1)`,
    [[ORG, OTHER_ORG]],
  );
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

  // Security regression: the ciphertext is bound to its organization_id via GCM
  // additional authenticated data. A row relocated to another org must fail to
  // authenticate — it must NOT hand the first org's service key to the second org,
  // and it must NOT be swallowed into a null "no credential" result.
  it('refuses to decrypt a row relocated to another organization', async () => {
    await setOperatorCredential(pool, ORG, 'bb_sk_org_a_only');

    await pool.query(
      `INSERT INTO dashboard_agent_operator_credentials (organization_id, ciphertext, iv, auth_tag)
       SELECT $2, ciphertext, iv, auth_tag
         FROM dashboard_agent_operator_credentials
        WHERE organization_id = $1`,
      [ORG, OTHER_ORG],
    );

    // The relocated row exists, so this is not the "absent" case.
    const raw = await pool.query(
      `SELECT ciphertext FROM dashboard_agent_operator_credentials WHERE organization_id=$1`,
      [OTHER_ORG],
    );
    expect(raw.rows).toHaveLength(1);

    // Loud failure: it must throw, and must never hand back org A's key or a
    // silent null that reads as "org B simply has no credential".
    let outcome: { ok: true; value: string | null } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await getOperatorCredential(pool, OTHER_ORG) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (outcome.ok) {
      // Only reachable on regression. Asserted first so the failure output names
      // the leaked credential rather than just "expected true to be false".
      expect(outcome.value).not.toBe('bb_sk_org_a_only');
      expect(outcome.value).not.toBeNull();
    }
    expect(outcome.ok).toBe(false);
    await expect(getOperatorCredential(pool, OTHER_ORG)).rejects.toThrow();

    // The victim org still reads correctly.
    expect(await getOperatorCredential(pool, ORG)).toBe('bb_sk_org_a_only');
  });

  // Security regression: a truncated GCM tag weakens forgery resistance, and Node
  // accepts short tags unless authTagLength is pinned. A truncated tag must throw.
  it('rejects a truncated auth tag', async () => {
    await setOperatorCredential(pool, ORG, 'bb_sk_tag_check');

    const r = await pool.query<{ auth_tag: string }>(
      `SELECT auth_tag FROM dashboard_agent_operator_credentials WHERE organization_id=$1`,
      [ORG],
    );
    const truncated = Buffer.from(r.rows[0].auth_tag, 'base64').subarray(0, 4).toString('base64');
    await pool.query(
      `UPDATE dashboard_agent_operator_credentials SET auth_tag=$1 WHERE organization_id=$2`,
      [truncated, ORG],
    );

    await expect(getOperatorCredential(pool, ORG)).rejects.toThrow();
  });
});
