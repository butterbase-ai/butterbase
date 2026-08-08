import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { operatorUserId, getOrCreateOperatorConversation, claimDueJobs } from '../operator-store.js';

const ORG = 'org-test-operator';
const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

beforeEach(async () => {
  await pool.query(`DELETE FROM dashboard_agent_operator_jobs WHERE organization_id=$1`, [ORG]);
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id=$1`, [ORG]);
});
afterAll(async () => { await pool.end(); });

describe('operatorUserId', () => {
  it('derives a stable sentinel from the org id', () => {
    expect(operatorUserId('org-abc')).toBe('operator:org-abc');
  });
});

describe('getOrCreateOperatorConversation', () => {
  it('creates one conversation per org and reuses it', async () => {
    const a = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
    const b = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
    expect(a).toBe(b);

    const r = await pool.query(
      `SELECT user_id, organization_id FROM dashboard_agent_conversations WHERE id=$1`, [a]
    );
    expect(r.rows[0].user_id).toBe('operator:org-test-operator');
    expect(r.rows[0].organization_id).toBe(ORG);
  });

  it('resolves concurrent calls for the same org to a single conversation', async () => {
    // Pre-warm N pool connections so the concurrent calls below actually run
    // on already-established sockets in parallel, instead of serializing
    // behind lazy connection setup (which would mask the TOCTOU race).
    const N = 8;
    const warm = await Promise.all(Array.from({ length: N }, () => pool.connect()));
    await Promise.all(warm.map((c) => c.release()));

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5'),
      ),
    );
    const uniqueIds = new Set(results);
    expect(uniqueIds.size).toBe(1);

    const r = await pool.query(
      `SELECT count(*)::int AS n FROM dashboard_agent_conversations WHERE organization_id = $1`,
      [ORG],
    );
    expect(r.rows[0].n).toBe(1);
  });
});

describe('claimDueJobs', () => {
  it('returns only due, enabled jobs and pushes next_run_at forward', async () => {
    await pool.query(
      `INSERT INTO dashboard_agent_operator_jobs
         (organization_id, name, instructions, interval_seconds, next_run_at)
       VALUES ($1,'sweep','Review the substrate.',600, now() - interval '1 minute')`, [ORG]
    );
    await pool.query(
      `INSERT INTO dashboard_agent_operator_jobs
         (organization_id, name, instructions, interval_seconds, next_run_at, enabled)
       VALUES ($1,'disabled','x',600, now() - interval '1 minute', FALSE)`, [ORG]
    );

    const jobs = await claimDueJobs(pool, 10);
    const mine = jobs.filter((j) => j.organizationId === ORG);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe('sweep');

    const again = await claimDueJobs(pool, 10);
    expect(again.filter((j) => j.organizationId === ORG)).toHaveLength(0);
  });
});
