import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('do-invoker bearer auth', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await SELF.fetch('https://do-invoker.test/invoke', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('unauthorized');
  });

  it('returns 401 when bearer is wrong', async () => {
    const res = await SELF.fetch('https://do-invoker.test/invoke', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts a request with the correct bearer (falls through to 501)', async () => {
    const res = await SELF.fetch('https://do-invoker.test/invoke', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(501);
  });
});
