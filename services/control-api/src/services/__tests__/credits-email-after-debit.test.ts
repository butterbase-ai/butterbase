import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendBillingEmail = vi.fn(async () => undefined);
vi.mock('../auth/email-service.js', () => ({ sendBillingEmail }));

const { fireCreditsEmailForOrg } = await import('../credits-email.js');

/**
 * Pool-shaped mock serving both the balance read and the credits-email org
 * read from one row, plus the owner-email lookup.
 */
function mockPool(monthly: string, topup: string) {
  const queries: string[] = [];
  return {
    queries,
    query: vi.fn(async (text: string) => {
      queries.push(text);
      if (/FROM organization_members/i.test(text)) {
        return { rows: [{ email: 'owner@acme.com' }], rowCount: 1 };
      }
      if (/^\s*SELECT/i.test(text)) {
        return {
          rows: [{
            auto_refill_enabled: false,
            auto_refill_last_failure_reason: null,
            auto_refill_threshold_usd: null,
            credits_low_emailed_at: null,
            credits_exhausted_emailed_at: null,
            monthly_allowance_usd: monthly,
            credits_usd: topup,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
}

beforeEach(() => { sendBillingEmail.mockClear(); });

describe('fireCreditsEmailForOrg', () => {
  it('warns the customer after a non-AI debit drains the balance', async () => {
    // people/apollo/enrichlayer spend goes through deductCreditsBalance, which
    // bypasses the lease subsystem entirely — nothing on that path told the
    // customer their credits were gone.
    const pool = mockPool('0.0000', '-0.0040');
    await fireCreditsEmailForOrg(pool as never, 'org-1');
    expect(sendBillingEmail).toHaveBeenCalledTimes(1);
    expect(sendBillingEmail.mock.calls[0][1]).toBe('credits_exhausted');
  });

  it('sums both pools when deciding the balance', async () => {
    const pool = mockPool('5.0000', '-0.5000');
    await fireCreditsEmailForOrg(pool as never, 'org-1');
    // $4.50 total is comfortably above the $1 default: nothing to send.
    expect(sendBillingEmail).not.toHaveBeenCalled();
  });

  it('never throws when the balance read fails', async () => {
    const pool = { query: vi.fn(async () => { throw new Error('db down'); }) };
    await expect(fireCreditsEmailForOrg(pool as never, 'org-1')).resolves.toBeUndefined();
    expect(sendBillingEmail).not.toHaveBeenCalled();
  });
});
