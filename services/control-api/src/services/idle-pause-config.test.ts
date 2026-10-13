import { describe, it, expect, vi } from 'vitest';
import { idlePausePlansFromEnv, isOnIdlePausePlan } from './idle-pause-config.js';

describe('idlePausePlansFromEnv', () => {
  it('defaults to playground when unset or blank', () => {
    expect(idlePausePlansFromEnv(undefined)).toEqual(['playground']);
    expect(idlePausePlansFromEnv(' , ')).toEqual(['playground']);
  });

  it('parses a comma list, trimming spaces', () => {
    expect(idlePausePlansFromEnv('playground, hobby')).toEqual(['playground', 'hobby']);
  });
});

describe('isOnIdlePausePlan', () => {
  const db = (rows: unknown[]) => ({ query: vi.fn().mockResolvedValue({ rows }) });

  it('reads the plan from the app org, not the owner personal org', async () => {
    const d = db([{ plan_id: 'playground' }]);
    expect(await isOnIdlePausePlan(d, 'app_1', ['playground'])).toBe(true);
    const [sql, params] = d.query.mock.calls[0];
    expect(sql).toMatch(/FROM org_app_index oai\s+JOIN organizations o ON o.id = oai.organization_id/);
    expect(params).toEqual(['app_1']);
  });

  it('is false on a paid plan', async () => {
    expect(await isOnIdlePausePlan(db([{ plan_id: 'pro' }]), 'app_1', ['playground'])).toBe(false);
  });

  it('is false when the app has no org row', async () => {
    expect(await isOnIdlePausePlan(db([]), 'app_1', ['playground'])).toBe(false);
  });

  it('lets a control DB failure propagate', async () => {
    const d = { query: vi.fn().mockRejectedValue(new Error('down')) };
    await expect(isOnIdlePausePlan(d, 'app_1', ['playground'])).rejects.toThrow('down');
  });
});
