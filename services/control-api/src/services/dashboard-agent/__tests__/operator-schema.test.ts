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

  it('adds a nullable resolved_by to approvals', async () => {
    const r = await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name='dashboard_agent_approvals' AND column_name='resolved_by'`
    );
    expect(r.rows[0]).toEqual({ data_type: 'text', is_nullable: 'YES' });
  });

  it('creates a per-org operator scratchpad table', async () => {
    const r = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name='dashboard_agent_operator_scratchpad' ORDER BY column_name`
    );
    const byName = Object.fromEntries(r.rows.map((x) => [x.column_name, x]));
    expect(byName.organization_id).toEqual({
      column_name: 'organization_id',
      data_type: 'text',
      is_nullable: 'NO',
    });
    expect(byName.content).toBeDefined();
    expect(byName.content.is_nullable).toBe('NO');
    expect(byName.updated_at).toBeDefined();
    expect(byName.updated_at.is_nullable).toBe('NO');
  });

  it('scratchpad is keyed one row per org (primary key on organization_id)', async () => {
    const r = await pool.query(
      `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'dashboard_agent_operator_scratchpad'::regclass AND i.indisprimary`
    );
    expect(r.rows.map((x) => x.attname)).toEqual(['organization_id']);
  });
});
