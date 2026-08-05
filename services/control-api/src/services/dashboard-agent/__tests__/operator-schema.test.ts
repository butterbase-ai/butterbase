import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

afterAll(async () => { await pool.end(); });

describe('operator schema', () => {
  it('adds organization_id to conversations', async () => {
    const r = await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name='dashboard_agent_conversations' AND column_name='organization_id'`
    );
    expect(r.rows[0]).toEqual({ data_type: 'text', is_nullable: 'YES' });
  });

  it('creates operator_jobs with a unique (org, name)', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='dashboard_agent_operator_jobs' ORDER BY column_name`
    );
    const cols = r.rows.map((x) => x.column_name);
    expect(cols).toContain('organization_id');
    expect(cols).toContain('instructions');
    expect(cols).toContain('next_run_at');
  });

  it('creates tool_executions keyed on approval_id', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='dashboard_agent_tool_executions' AND column_name='approval_id'`
    );
    expect(r.rowCount).toBe(1);
  });
});
