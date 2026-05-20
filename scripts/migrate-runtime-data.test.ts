import { describe, it, expect } from 'vitest';
import { RUNTIME_TABLES, parseArgs } from './migrate-runtime-data.js';

describe('migrate-runtime-data', () => {
  it('exports the canonical 39-table list', () => {
    expect(RUNTIME_TABLES).toContain('apps');
    expect(RUNTIME_TABLES).toContain('app_users');
    expect(RUNTIME_TABLES).toContain('agent_runs');
    expect(RUNTIME_TABLES.length).toBeGreaterThanOrEqual(39);
  });

  it('parses --region flag', () => {
    expect(parseArgs(['--region', 'us-east-1'])).toEqual({ region: 'us-east-1', dryRun: false, verify: false });
  });

  it('parses --dry-run flag', () => {
    expect(parseArgs(['--region', 'us-east-1', '--dry-run'])).toEqual({ region: 'us-east-1', dryRun: true, verify: false });
  });

  it('parses --verify flag', () => {
    expect(parseArgs(['--region', 'us-east-1', '--verify'])).toEqual({ region: 'us-east-1', dryRun: false, verify: true });
  });

  it('throws when --region is missing', () => {
    expect(() => parseArgs([])).toThrow(/--region required/);
  });
});
