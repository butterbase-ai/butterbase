import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scanLowBalanceOnce } from '../low-balance-notifier.js';

interface LowRow {
  id: string;
  name: string;
  plan_id: string;
  monthly: string;
  topup: string;
  balance: string;
  eff_floor: string;
}

function row(over: Partial<LowRow> = {}): LowRow {
  return {
    id: 'org-1',
    name: 'Acme',
    plan_id: 'enterprise',
    monthly: '0.0000',
    topup: '0.4000',
    balance: '0.4000',
    eff_floor: '0.0000',
    ...over,
  };
}

function mockPool(rows: LowRow[]) {
  const queries: { text: string; values: unknown[] }[] = [];
  return {
    queries,
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      return { rows, rowCount: rows.length };
    }),
  };
}

/** Redis mock whose `set(..., 'NX')` returns null for keys already claimed. */
function mockRedis(claimed: string[] = []) {
  const seen = new Set(claimed);
  return {
    seen,
    set: vi.fn(async (key: string) => {
      if (seen.has(key)) return null;
      seen.add(key);
      return 'OK';
    }),
  };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let sendEmail: ReturnType<typeof vi.fn>;
let sendChat: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendEmail = vi.fn(async () => undefined);
  sendChat = vi.fn(async () => true);
  log.info.mockClear(); log.warn.mockClear(); log.error.mockClear();
});

afterEach(() => {
  delete process.env.OPS_LOW_BALANCE_THRESHOLD_USD;
  delete process.env.OPS_LOW_BALANCE_PLANS;
  delete process.env.OPS_ALERT_EMAIL;
});

describe('scanLowBalanceOnce', () => {
  it('sends nothing when no org is below the threshold', async () => {
    const pool = mockPool([]);
    const result = await scanLowBalanceOnce({
      pool: pool as never, redis: mockRedis() as never, sendEmail, sendChat, log,
    });
    expect(result.alerted).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('queries only paid plans by default, not playground', async () => {
    // 379 playground orgs sit under $1 at any moment; including them would
    // bury the handful of paying customers that actually need a response.
    const pool = mockPool([]);
    await scanLowBalanceOnce({ pool: pool as never, redis: mockRedis() as never, sendEmail, sendChat, log });
    const [{ values }] = pool.queries;
    expect(values[1]).toEqual(['launch', 'certified', 'enterprise']);
  });

  it('honours an explicit plan list from the environment', async () => {
    process.env.OPS_LOW_BALANCE_PLANS = 'playground,launch';
    const pool = mockPool([]);
    await scanLowBalanceOnce({ pool: pool as never, redis: mockRedis() as never, sendEmail, sendChat, log });
    expect(pool.queries[0].values[1]).toEqual(['playground', 'launch']);
  });

  it('defaults the threshold to $1 and passes it to the query', async () => {
    const pool = mockPool([]);
    await scanLowBalanceOnce({ pool: pool as never, redis: mockRedis() as never, sendEmail, sendChat, log });
    expect(pool.queries[0].values[0]).toBe(1);
  });

  it('restricts the scan to active orgs', async () => {
    // A suspended or closed org sitting at $0 is expected, not actionable.
    const pool = mockPool([]);
    await scanLowBalanceOnce({ pool: pool as never, redis: mockRedis() as never, sendEmail, sendChat, log });
    expect(pool.queries[0].text).toMatch(/account_status\s*=\s*'active'/i);
  });

  it('sends one digest email and one chat message for a batch, not one per org', async () => {
    const pool = mockPool([
      row({ id: 'a', name: 'Acme', balance: '0.4000' }),
      row({ id: 'b', name: 'Globex', balance: '-0.0040' }),
    ]);
    const result = await scanLowBalanceOnce({
      pool: pool as never, redis: mockRedis() as never, sendEmail, sendChat, log,
    });
    expect(result.alerted.map((o) => o.id)).toEqual(['a', 'b']);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendChat).toHaveBeenCalledTimes(1);
  });

  it('addresses the digest to OPS_ALERT_EMAIL', async () => {
    process.env.OPS_ALERT_EMAIL = 'alerts@butterbase.ai';
    const pool = mockPool([row()]);
    await scanLowBalanceOnce({ pool: pool as never, redis: mockRedis() as never, sendEmail, sendChat, log });
    expect(sendEmail.mock.calls[0][0]).toBe('alerts@butterbase.ai');
    expect(sendEmail.mock.calls[0][1]).toBe('org_balance_low_ops');
  });

  it('skips an org already alerted within the dedup window', async () => {
    const pool = mockPool([row({ id: 'a' }), row({ id: 'b' })]);
    const redis = mockRedis(['ops_low_balance:a']);
    const result = await scanLowBalanceOnce({
      pool: pool as never, redis: redis as never, sendEmail, sendChat, log,
    });
    expect(result.alerted.map((o) => o.id)).toEqual(['b']);
  });

  it('sends nothing at all when every low org is already deduped', async () => {
    const pool = mockPool([row({ id: 'a' })]);
    const redis = mockRedis(['ops_low_balance:a']);
    await scanLowBalanceOnce({ pool: pool as never, redis: redis as never, sendEmail, sendChat, log });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('names the org and its balance in the chat message', async () => {
    const pool = mockPool([row({ name: 'Globex', balance: '-0.0040', plan_id: 'enterprise' })]);
    await scanLowBalanceOnce({ pool: pool as never, redis: mockRedis() as never, sendEmail, sendChat, log });
    const text = sendChat.mock.calls[0][0] as string;
    expect(text).toContain('Globex');
    expect(text).toContain('enterprise');
    expect(text).toContain('-0.00');
  });

  it('flags orgs that are already cut off distinctly from merely low ones', async () => {
    // Below zero means the floor is now refusing their calls — a different
    // urgency from "getting close", and the thing the team must act on.
    const pool = mockPool([
      row({ id: 'low', name: 'StillUp', balance: '0.4000' }),
      row({ id: 'dead', name: 'CutOff', balance: '-0.0040' }),
    ]);
    const result = await scanLowBalanceOnce({
      pool: pool as never, redis: mockRedis() as never, sendEmail, sendChat, log,
    });
    expect(result.alerted.find((o) => o.id === 'dead')?.cutOff).toBe(true);
    expect(result.alerted.find((o) => o.id === 'low')?.cutOff).toBe(false);
  });

  it('still emails when the chat webhook fails', async () => {
    sendChat = vi.fn(async () => false);
    const pool = mockPool([row()]);
    await scanLowBalanceOnce({ pool: pool as never, redis: mockRedis() as never, sendEmail, sendChat, log });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('still chats when the email send throws', async () => {
    sendEmail = vi.fn(async () => { throw new Error('SES down'); });
    const pool = mockPool([row()]);
    await expect(scanLowBalanceOnce({
      pool: pool as never, redis: mockRedis() as never, sendEmail, sendChat, log,
    })).resolves.toBeTruthy();
    expect(sendChat).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the database query fails', async () => {
    const pool = { queries: [], query: vi.fn(async () => { throw new Error('db down'); }) };
    const result = await scanLowBalanceOnce({
      pool: pool as never, redis: mockRedis() as never, sendEmail, sendChat, log,
    });
    expect(result.alerted).toEqual([]);
    expect(log.error).toHaveBeenCalled();
  });
});
