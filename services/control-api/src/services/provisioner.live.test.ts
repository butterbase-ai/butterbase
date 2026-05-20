import { describe, it, expect } from 'vitest';
import { provisionAppDb } from './provisioner.js';
import pg from 'pg';

const RUN_LIVE = process.env.E2E_LIVE === '1';

describe.skipIf(!RUN_LIVE)('provisionAppDb (live)', () => {
  it('creates DB and URI works', async () => {
    process.env.NEON_DATA_PROJECT_ID_EU_WEST_1 ??=
      'postgresql://butterbase:butterbase_dev@localhost:5436/butterbase_data_eu';
    const r = await provisionAppDb('eu-west-1', 'live-test-123', 'owner');
    expect(r.neonDbName).toBe('cust_live_test_123_eu_west_1');
    expect(r.connectionUri).toContain(r.neonDbName);

    const pool = new pg.Pool({ connectionString: r.connectionUri });
    try {
      const v = await pool.query('SELECT 1 AS ok');
      expect(v.rows[0].ok).toBe(1);
    } finally { await pool.end(); }
  });

  it('is idempotent', async () => {
    const r1 = await provisionAppDb('eu-west-1', 'live-test-123', 'owner');
    const r2 = await provisionAppDb('eu-west-1', 'live-test-123', 'owner');
    expect(r1).toEqual(r2);
  });
});
