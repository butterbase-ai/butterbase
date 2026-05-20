import { describe, it, expect, vi, beforeEach } from 'vitest';
import { maybeSendCreditsEmail, resetCreditsEmailState } from '../credits-email.js';

type FakeRow = Record<string, unknown>;

// Minimal Pool-like mock that captures queries.
function mockDb(selectRows: FakeRow[] = []) {
  const queries: { text: string; values: unknown[] }[] = [];
  return {
    queries,
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      // Return the next row for SELECTs; empty for UPDATEs.
      if (/^\s*SELECT/i.test(text)) {
        const row = selectRows.shift();
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

// Production signature: sendBillingEmail(to, template, data)
const sendBillingEmail = vi.fn(async (_to: string, _template: string, _data: Record<string, string>) => undefined);

describe('maybeSendCreditsEmail', () => {
  beforeEach(() => { sendBillingEmail.mockClear(); });

  it('skips when auto-refill is on and healthy', async () => {
    const db = mockDb([{
      email: 'a@b.com',
      auto_refill_enabled: true,
      auto_refill_last_failure_reason: null,
      credits_low_emailed_at: null,
      credits_exhausted_emailed_at: null,
      monthly_allowance_usd: '0.00',
      credits_usd: '0.00',
    }]);
    await maybeSendCreditsEmail({ db: db as never, userId: 'u1', postBalance: 0, sendBillingEmail });
    expect(sendBillingEmail).not.toHaveBeenCalled();
  });

  it('sends credits_exhausted when balance is 0 and not yet emailed', async () => {
    const db = mockDb([{
      email: 'a@b.com',
      auto_refill_enabled: false,
      auto_refill_last_failure_reason: null,
      credits_low_emailed_at: null,
      credits_exhausted_emailed_at: null,
      monthly_allowance_usd: '0.00',
      credits_usd: '0.00',
    }]);
    await maybeSendCreditsEmail({ db: db as never, userId: 'u1', postBalance: 0, sendBillingEmail });
    expect(sendBillingEmail).toHaveBeenCalledTimes(1);
    // Second positional arg is the template name
    const template = sendBillingEmail.mock.calls[0][1] as string;
    expect(template).toBe('credits_exhausted');
  });

  it('does not double-send credits_exhausted', async () => {
    const db = mockDb([{
      email: 'a@b.com',
      auto_refill_enabled: false,
      auto_refill_last_failure_reason: null,
      credits_low_emailed_at: null,
      credits_exhausted_emailed_at: new Date().toISOString(),
      monthly_allowance_usd: '0.00',
      credits_usd: '0.00',
    }]);
    await maybeSendCreditsEmail({ db: db as never, userId: 'u1', postBalance: 0, sendBillingEmail });
    expect(sendBillingEmail).not.toHaveBeenCalled();
  });

  it('sends credits_low when below threshold and not yet emailed', async () => {
    const db = mockDb([{
      email: 'a@b.com',
      auto_refill_enabled: false,
      auto_refill_last_failure_reason: null,
      credits_low_emailed_at: null,
      credits_exhausted_emailed_at: null,
      monthly_allowance_usd: '0.50',
      credits_usd: '0.00',
    }]);
    await maybeSendCreditsEmail({ db: db as never, userId: 'u1', postBalance: 0.5, sendBillingEmail });
    expect(sendBillingEmail).toHaveBeenCalledTimes(1);
    const template = sendBillingEmail.mock.calls[0][1] as string;
    expect(template).toBe('credits_low');
  });

  it('sends credits_low even when auto-refill is on but currently failing', async () => {
    const db = mockDb([{
      email: 'a@b.com',
      auto_refill_enabled: true,
      auto_refill_last_failure_reason: 'card_declined',
      credits_low_emailed_at: null,
      credits_exhausted_emailed_at: null,
      monthly_allowance_usd: '0.50',
      credits_usd: '0.00',
    }]);
    await maybeSendCreditsEmail({ db: db as never, userId: 'u1', postBalance: 0.5, sendBillingEmail });
    expect(sendBillingEmail).toHaveBeenCalledTimes(1);
  });
});

describe('resetCreditsEmailState', () => {
  it('nulls both timestamps', async () => {
    const db = mockDb();
    await resetCreditsEmailState(db as never, 'u1');
    const text = db.queries[0].text;
    expect(text).toMatch(/credits_low_emailed_at\s*=\s*NULL/i);
    expect(text).toMatch(/credits_exhausted_emailed_at\s*=\s*NULL/i);
  });
});
