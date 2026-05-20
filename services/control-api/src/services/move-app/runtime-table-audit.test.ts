import { describe, it, expect, vi } from 'vitest';
import { auditRuntimeTablesForPool } from './runtime-table-audit.js';

describe('auditRuntimeTablesForPool', () => {
  it('passes when every app_id table is classified', async () => {
    const fakePool = { query: vi.fn().mockResolvedValue({ rows: [{ table_name: 'app_users' }, { table_name: 'partner_keys' }] }) };
    await expect(auditRuntimeTablesForPool(fakePool as any, 'us-east-1')).resolves.toBeUndefined();
  });

  it('throws when a per-app table is unclassified', async () => {
    const fakePool = { query: vi.fn().mockResolvedValue({ rows: [{ table_name: 'app_users' }, { table_name: 'something_unknown' }] }) };
    await expect(auditRuntimeTablesForPool(fakePool as any, 'us-east-1')).rejects.toThrow(/something_unknown/);
  });

  it('error message names the file to edit', async () => {
    const fakePool = { query: vi.fn().mockResolvedValue({ rows: [{ table_name: 'new_per_app_thing' }] }) };
    await expect(auditRuntimeTablesForPool(fakePool as any, 'eu-west-1')).rejects.toThrow(/runtime-tables\.ts/);
  });
});
