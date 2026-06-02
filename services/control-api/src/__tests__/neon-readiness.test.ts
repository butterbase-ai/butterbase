import { describe, it, expect } from 'vitest';
import { waitUntilUriQueryable } from '../services/neon-client.js';

function pgError(code: string): Error {
  const err = new Error(`pg error ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

describe('waitUntilUriQueryable', () => {
  it('returns on first success', async () => {
    let calls = 0;
    await waitUntilUriQueryable('postgres://x/db_test', 'db_test', {
      probe: async () => { calls++; },
      backoffsMs: [1],
    });
    expect(calls).toBe(1);
  });

  it('retries on 3D000 and succeeds when the DB becomes queryable', async () => {
    let calls = 0;
    await waitUntilUriQueryable('postgres://x/db_test', 'db_test', {
      probe: async () => {
        calls++;
        if (calls < 3) throw pgError('3D000');
      },
      backoffsMs: [1],
    });
    expect(calls).toBe(3);
  });

  it('retries on connection-class errors (08006, ECONNREFUSED)', async () => {
    let calls = 0;
    await waitUntilUriQueryable('postgres://x/db_test', 'db_test', {
      probe: async () => {
        calls++;
        if (calls === 1) throw pgError('ECONNREFUSED');
        if (calls === 2) throw pgError('08006');
      },
      backoffsMs: [1],
    });
    expect(calls).toBe(3);
  });

  it('rethrows immediately on non-retryable codes (28P01 auth)', async () => {
    let calls = 0;
    await expect(
      waitUntilUriQueryable('postgres://x/db_test', 'db_test', {
        probe: async () => { calls++; throw pgError('28P01'); },
        backoffsMs: [1],
      }),
    ).rejects.toThrow(/28P01/);
    expect(calls).toBe(1);
  });

  it('rethrows immediately on errors without a code', async () => {
    let calls = 0;
    await expect(
      waitUntilUriQueryable('postgres://x/db_test', 'db_test', {
        probe: async () => { calls++; throw new Error('no code on this'); },
        backoffsMs: [1],
      }),
    ).rejects.toThrow(/no code/);
    expect(calls).toBe(1);
  });

  it('escalates to a loud incident error past the timeout', async () => {
    let calls = 0;
    await expect(
      waitUntilUriQueryable('postgres://x/db_test', 'db_test', {
        probe: async () => { calls++; throw pgError('3D000'); },
        timeoutMs: 30,   // small enough to elapse during this test
        backoffsMs: [10],
      }),
    ).rejects.toThrow(/not queryable after 30ms.*propagation incident/s);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
