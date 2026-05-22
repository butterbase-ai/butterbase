import { describe, it, expect, vi } from 'vitest';
import { resolveApp } from '../src/auth.js';

describe('resolveApp', () => {
  it('calls control-api and returns app_id + region + redis_password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ app_id: 'app_abc', region: 'us', redis_password: 'pw' }), { status: 200 }),
    );
    const res = await resolveApp({
      apiKey: 'bb_live_xxx',
      env: { CONTROL_API_URL: 'http://ctl', INTERNAL_SECRET: 'sek' } as any,
      fetch: fetchMock,
    });
    expect(res).toEqual({ appId: 'app_abc', region: 'us', redisPassword: 'pw' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/internal/kv/resolve-key'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-internal-secret': 'sek' }),
      }),
    );
  });

  it('returns null on 401/404 from control-api', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const res = await resolveApp({
      apiKey: 'bad',
      env: { CONTROL_API_URL: 'http://ctl', INTERNAL_SECRET: 'sek' } as any,
      fetch: fetchMock,
    });
    expect(res).toBeNull();
  });
});
