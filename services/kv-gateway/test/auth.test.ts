import { describe, it, expect, vi } from 'vitest';
import { resolveApp } from '../src/auth.js';

describe('resolveApp', () => {
  it('calls control-api and returns app_id + region + redis_password for a valid key and owned app', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ app_id: 'app_abc', region: 'us', redis_password: 'pw' }), { status: 200 }),
    );
    const res = await resolveApp({
      apiKey: 'bb_live_xxx',
      appId: 'app_abc',
      env: { CONTROL_API_URL: 'http://ctl', INTERNAL_SECRET: 'sek' } as any,
      fetch: fetchMock,
    });
    expect(res).toEqual({ appId: 'app_abc', region: 'us', redisPassword: 'pw' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/internal/kv/resolve-key'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-butterbase-internal-secret': 'sek' }),
      }),
    );
    // Assert request body includes both api_key and app_id
    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.api_key).toBe('bb_live_xxx');
    expect(body.app_id).toBe('app_abc');
  });

  it('returns null on 401/404 from control-api (bad key)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const res = await resolveApp({
      apiKey: 'bad',
      appId: 'app_abc',
      env: { CONTROL_API_URL: 'http://ctl', INTERNAL_SECRET: 'sek' } as any,
      fetch: fetchMock,
    });
    expect(res).toBeNull();
  });

  it('returns null on 403 from control-api (valid key but app not owned by key user)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
    const res = await resolveApp({
      apiKey: 'bb_live_valid_but_wrong_app',
      appId: 'app_not_owned',
      env: { CONTROL_API_URL: 'http://ctl', INTERNAL_SECRET: 'sek' } as any,
      fetch: fetchMock,
    });
    expect(res).toBeNull();
  });
});
