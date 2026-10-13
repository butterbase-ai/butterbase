import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
vi.mock('../../region-resolver.js', () => ({ resolveAppHomeRegion: vi.fn(async () => 'us-east-1') }));
vi.mock('../../runtime-db.js', () => ({ getRuntimeDbPool: () => ({ query }) }));
vi.mock('../../failure-notifications.service.js', () => ({ notifyAuthHookFailed: vi.fn() }));
vi.mock('../../../config.js', () => ({ config: { runtimeDb: {}, runtimeUrl: 'http://deno' } }));

const { fireAuthHook } = await import('../auth-hook-service.js');

const payload = {
  event: 'login',
  user: { id: 'u1', email: 'a@b.c', provider: 'email' },
  isNewUser: false,
  provider: 'email',
} as never;

describe('fireAuthHook on a paused app', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    query.mockReset();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('does not call the runtime', async () => {
    query.mockResolvedValue({ rows: [{ auth_hook_function: 'onLogin', paused: true }] });
    fireAuthHook({} as never, 'app_1', payload, { warn: vi.fn() });
    await new Promise((r) => setTimeout(r, 10));
    expect(query.mock.calls[0][0]).toMatch(/SELECT auth_hook_function, paused FROM apps/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still fires for a running app', async () => {
    query.mockResolvedValue({ rows: [{ auth_hook_function: 'onLogin', paused: false }] });
    fireAuthHook({} as never, 'app_1', payload, { warn: vi.fn() });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).toHaveBeenCalled();
  });
});
