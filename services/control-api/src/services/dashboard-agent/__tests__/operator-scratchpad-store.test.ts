import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  getOperatorScratchpad,
  setOperatorScratchpad,
  OPERATOR_SCRATCHPAD_MAX_CHARS,
} from '../operator-scratchpad-store.js';

const ORG = 'org-test-scratchpad';
const OTHER_ORG = 'org-test-scratchpad-other';
const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

beforeEach(async () => {
  await pool.query(`DELETE FROM dashboard_agent_operator_scratchpad WHERE organization_id IN ($1, $2)`, [
    ORG,
    OTHER_ORG,
  ]);
});
afterAll(async () => {
  await pool.end();
});

describe('getOperatorScratchpad', () => {
  it('returns null when the org has never written one', async () => {
    const result = await getOperatorScratchpad(pool, ORG);
    expect(result).toBeNull();
  });
});

describe('setOperatorScratchpad', () => {
  it('round-trips content', async () => {
    await setOperatorScratchpad(pool, ORG, 'standing fact: org uses Stripe billing.');
    const result = await getOperatorScratchpad(pool, ORG);
    expect(result?.content).toBe('standing fact: org uses Stripe billing.');
    expect(result?.organizationId).toBe(ORG);
    expect(result?.updatedAt).toBeDefined();
  });

  it('replaces rather than duplicates on re-write', async () => {
    await setOperatorScratchpad(pool, ORG, 'first version');
    await setOperatorScratchpad(pool, ORG, 'second version');

    const result = await getOperatorScratchpad(pool, ORG);
    expect(result?.content).toBe('second version');

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM dashboard_agent_operator_scratchpad WHERE organization_id = $1`,
      [ORG],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('advances updated_at on re-write', async () => {
    const first = await setOperatorScratchpad(pool, ORG, 'v1');
    await new Promise((r) => setTimeout(r, 10));
    const second = await setOperatorScratchpad(pool, ORG, 'v2');
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThan(new Date(first.updatedAt).getTime());
  });

  it('is isolated per org — one org cannot read another org\'s scratchpad', async () => {
    await setOperatorScratchpad(pool, ORG, 'org content');
    await setOperatorScratchpad(pool, OTHER_ORG, 'other org content');

    const mine = await getOperatorScratchpad(pool, ORG);
    const theirs = await getOperatorScratchpad(pool, OTHER_ORG);

    expect(mine?.content).toBe('org content');
    expect(theirs?.content).toBe('other org content');
    expect(mine?.content).not.toBe(theirs?.content);
  });

  it('rejects content over the size cap rather than truncating', async () => {
    const oversized = 'x'.repeat(OPERATOR_SCRATCHPAD_MAX_CHARS + 1);
    await expect(setOperatorScratchpad(pool, ORG, oversized)).rejects.toThrow();

    // Confirm nothing was written (no silent partial/truncated row).
    const result = await getOperatorScratchpad(pool, ORG);
    expect(result).toBeNull();
  });

  it('accepts content exactly at the cap', async () => {
    const atCap = 'x'.repeat(OPERATOR_SCRATCHPAD_MAX_CHARS);
    const result = await setOperatorScratchpad(pool, ORG, atCap);
    expect(result.content.length).toBe(OPERATOR_SCRATCHPAD_MAX_CHARS);
  });
});
