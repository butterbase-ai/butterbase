import { describe, it, expect, vi } from 'vitest';
import { isolateStagingApp, isolateStagingMeetingsWebhook } from './staging-isolation.js';

function fakeDb(counts: number[]) {
  const query = vi.fn();
  counts.forEach((c) => query.mockResolvedValueOnce({ rowCount: c }));
  return { pool: { query } as never, query };
}

describe('isolateStagingApp', () => {
  it('clears connected accounts, disables integrations, and disables cron triggers', async () => {
    const { pool, query } = fakeDb([3, 2, 4]);
    const result = await isolateStagingApp(pool, 'app_staging');
    expect(result).toEqual({
      clearedConnectedAccounts: 3,
      disabledIntegrations: 2,
      disabledCronTriggers: 4,
    });
    expect(query).toHaveBeenCalledTimes(3);
    for (const call of query.mock.calls) {
      expect(call[1]).toEqual(['app_staging']);
    }
  });

  it('reports zero when the staging app inherited nothing', async () => {
    const { pool } = fakeDb([0, 0, 0]);
    expect(await isolateStagingApp(pool, 'app_staging'))
      .toEqual({ clearedConnectedAccounts: 0, disabledIntegrations: 0, disabledCronTriggers: 0 });
  });

  it('never issues a statement without an app_id parameter', async () => {
    const { pool, query } = fakeDb([0, 0, 0]);
    await isolateStagingApp(pool, 'app_staging');
    expect(query.mock.calls.length).toBeGreaterThan(0);
    for (const call of query.mock.calls) {
      expect(call[0]).toContain('app_id = $1');
      expect(call[1]).toEqual(['app_staging']);
    }
  });

  it('disables only cron triggers, not other trigger types', async () => {
    const { pool, query } = fakeDb([0, 0, 1]);
    await isolateStagingApp(pool, 'app_staging');
    const cronCall = query.mock.calls.find((c) => String(c[0]).includes('function_triggers'));
    expect(cronCall?.[0]).toContain(`trigger_type = 'cron'`);
    expect(cronCall?.[0]).toMatch(/UPDATE function_triggers SET enabled = false/);
  });
});

describe('isolateStagingMeetingsWebhook', () => {
  it('is a no-op when the staging app has no meetings webhook row', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const result = await isolateStagingMeetingsWebhook({ query } as never, 'app_staging');
    expect(result).toEqual({ deleted: false });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('keeps a self-referential forward URL that already points at the staging app', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ forward_url: 'https://api.butterbase.ai/v1/app_staging/fn/notetaker-webhook' }],
    });
    const result = await isolateStagingMeetingsWebhook({ query } as never, 'app_staging');
    expect(result).toEqual({ deleted: false });
    // Only the SELECT ran — no DELETE was issued against a row that targets this app.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('deletes a forward URL that does not point at the staging app', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ forward_url: 'https://prod.example.com/webhooks/notetaker' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const result = await isolateStagingMeetingsWebhook({ query } as never, 'app_staging');
    expect(result).toEqual({ deleted: true });
    expect(query).toHaveBeenCalledTimes(2);
    for (const call of query.mock.calls) {
      expect(call[0]).toContain('app_id = $1');
      expect(call[1]).toEqual(['app_staging']);
    }
  });
});
