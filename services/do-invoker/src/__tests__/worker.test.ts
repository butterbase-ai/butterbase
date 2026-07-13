import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('do-invoker scaffold', () => {
  it('returns 501 from the placeholder handler', async () => {
    const res = await SELF.fetch('https://do-invoker.test/anything', { method: 'POST' });
    expect(res.status).toBe(501);
  });
});
