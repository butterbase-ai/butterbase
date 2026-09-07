import { describe, it, expect, vi, beforeEach } from 'vitest';
import { maybeSendCreditsEmail, resetCreditsEmailState } from '../credits-email.js';

type FakeRow = Record<string, unknown>;

/**
 * Minimal Pool-like mock that dispatches by SQL shape:
 *   - the org SELECT returns `orgRow`
 *   - the organization_members owner-email SELECT returns `ownerEmails`
 *   - the marker-claiming UPDATE reports `claimRowCount` rows affected, so a
 *     test can simulate losing the race to a concurrent settle
 */
function mockDb(orgRow: FakeRow | null, ownerEmails: string[] = ['a@b.com'], claimRowCount = 1) {
  const queries: { text: string; values: unknown[] }[] = [];
  return {
    queries,
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      if (/FROM organization_members/i.test(text)) {
        return { rows: ownerEmails.map((email) => ({ email })), rowCount: ownerEmails.length };
      }
      if (/^\s*SELECT/i.test(text)) {
        return { rows: orgRow ? [orgRow] : [], rowCount: orgRow ? 1 : 0 };
      }
      return { rows: [], rowCount: claimRowCount };
    }),
  };
}

function orgRow(over: FakeRow = {}): FakeRow {
  return {
    auto_refill_enabled: false,
    auto_refill_last_failure_reason: null,
    auto_refill_threshold_usd: null,
    credits_low_emailed_at: null,
    credits_exhausted_emailed_at: null,
    monthly_allowance_usd: '0.00',
    credits_usd: '0.00',
    ...over,
  };
}

// Production signature: sendBillingEmail(to, template, data)
const sendBillingEmail = vi.fn(async (_to: string, _template: string, _data: Record<string, string>) => undefined);

const ORG = 'org-1';

describe('maybeSendCreditsEmail', () => {
  beforeEach(() => { sendBillingEmail.mockClear(); });

  it('skips when auto-refill is on and healthy', async () => {
    const db = mockDb(orgRow({ auto_refill_enabled: true }));
    await maybeSendCreditsEmail({ db: db as never, organizationId: ORG, postBalance: 0, sendBillingEmail });
    expect(sendBillingEmail).not.toHaveBeenCalled();
  });

  it('sends credits_exhausted when balance is 0 and not yet emailed', async () => {
    const db = mockDb(orgRow());
    await maybeSendCreditsEmail({ db: db as never, organizationId: ORG, postBalance: 0, sendBillingEmail });
    expect(sendBillingEmail).toHaveBeenCalledTimes(1);
    expect(sendBillingEmail.mock.calls[0][1]).toBe('credits_exhausted');
  });

  it('does not double-send credits_exhausted', async () => {
    const db = mockDb(orgRow({ credits_exhausted_emailed_at: new Date().toISOString() }));
    await maybeSendCreditsEmail({ db: db as never, organizationId: ORG, postBalance: 0, sendBillingEmail });
    expect(sendBillingEmail).not.toHaveBeenCalled();
  });

  it('sends credits_low when below threshold and not yet emailed', async () => {
    const db = mockDb(orgRow({ monthly_allowance_usd: '0.50' }));
    await maybeSendCreditsEmail({ db: db as never, organizationId: ORG, postBalance: 0.5, sendBillingEmail });
    expect(sendBillingEmail).toHaveBeenCalledTimes(1);
    expect(sendBillingEmail.mock.calls[0][1]).toBe('credits_low');
  });

  it('sends credits_low even when auto-refill is on but currently failing', async () => {
    const db = mockDb(orgRow({
      auto_refill_enabled: true,
      auto_refill_last_failure_reason: 'card_declined',
      monthly_allowance_usd: '0.50',
    }));
    await maybeSendCreditsEmail({ db: db as never, organizationId: ORG, postBalance: 0.5, sendBillingEmail });
    expect(sendBillingEmail).toHaveBeenCalledTimes(1);
  });

  it("warns at the org's configured threshold, not the deployment default", async () => {
    // $8 is far above the $1 default but below this org's $20.
    const db = mockDb(orgRow({ auto_refill_threshold_usd: '20.00', credits_usd: '8.00' }));
    await maybeSendCreditsEmail({ db: db as never, organizationId: ORG, postBalance: 8, sendBillingEmail });
    expect(sendBillingEmail).toHaveBeenCalledTimes(1);
    expect(sendBillingEmail.mock.calls[0][1]).toBe('credits_low');
    expect((sendBillingEmail.mock.calls[0][2] as Record<string, string>).threshold_usd).toBe('20.00');
  });

  it('reads the org that was billed, not any user', async () => {
    const db = mockDb(orgRow());
    await maybeSendCreditsEmail({ db: db as never, organizationId: ORG, postBalance: 0, sendBillingEmail });
    const select = db.queries[0];
    expect(select.text).toMatch(/FROM organizations o/i);
    expect(select.text).not.toMatch(/personal_organization_id/i);
    expect(select.values).toEqual([ORG]);
  });

  it('emails every owner of a team org', async () => {
    const db = mockDb(orgRow(), ['one@x.com', 'two@x.com']);
    await maybeSendCreditsEmail({ db: db as never, organizationId: ORG, postBalance: 0, sendBillingEmail });
    expect(sendBillingEmail).toHaveBeenCalledTimes(2);
    expect(sendBillingEmail.mock.calls.map((c) => c[0]).sort()).toEqual(['one@x.com', 'two@x.com']);
  });

  it('sends nothing when the org has no owner with an email', async () => {
    const db = mockDb(orgRow(), []);
    await maybeSendCreditsEmail({ db: db as never, organizationId: ORG, postBalance: 0, sendBillingEmail });
    expect(sendBillingEmail).not.toHaveBeenCalled();
  });

  it('stamps the dedup marker before sending', async () => {
    const db = mockDb(orgRow());
    await maybeSendCreditsEmail({ db: db as never, organizationId: ORG, postBalance: 0, sendBillingEmail });
    const update = db.queries.find((q) => /^\s*UPDATE organizations/i.test(q.text));
    expect(update).toBeDefined();
    expect(update!.text).toMatch(/credits_exhausted_emailed_at = now\(\)/i);
    expect(update!.text).toMatch(/credits_exhausted_emailed_at IS NULL/i);
  });

  it('sends nothing when a concurrent settle already claimed the marker', async () => {
    const db = mockDb(orgRow(), ['a@b.com'], 0);
    await maybeSendCreditsEmail({ db: db as never, organizationId: ORG, postBalance: 0, sendBillingEmail });
    expect(sendBillingEmail).not.toHaveBeenCalled();
  });

  it('does not let one failing recipient suppress the others', async () => {
    const db = mockDb(orgRow(), ['bad@x.com', 'good@x.com']);
    const flaky = vi.fn(async (to: string) => {
      if (to === 'bad@x.com') throw new Error('bounce');
    });
    await maybeSendCreditsEmail({
      db: db as never,
      organizationId: ORG,
      postBalance: 0,
      sendBillingEmail: flaky as never,
    });
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});

describe('resetCreditsEmailState', () => {
  it('nulls both timestamps on the org', async () => {
    const db = mockDb(null);
    await resetCreditsEmailState(db as never, ORG);
    const text = db.queries[0].text;
    expect(text).toMatch(/UPDATE organizations/i);
    expect(text).toMatch(/credits_low_emailed_at\s*=\s*NULL/i);
    expect(text).toMatch(/credits_exhausted_emailed_at\s*=\s*NULL/i);
    expect(db.queries[0].values).toEqual([ORG]);
  });
});
