import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveApp = vi.fn();
const resolveAppPublic = vi.fn();
vi.mock('../../services/app-resolver.js', async (orig) => {
  const actual = await orig<typeof import('../../services/app-resolver.js')>();
  return { ...actual, AppResolver: { resolveApp, resolveAppPublic } };
});
vi.mock('../../services/region-resolver.js', async (orig) => ({
  ...(await orig<object>()),
  getRuntimeDbForApp: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [{ connection_string: 'postgres://x' }] })) })),
  resolveAppHomeRegion: vi.fn(async () => 'us-east-1'),
}));
vi.mock('../../services/end-user-auth.js', async (orig) => ({
  ...(await orig<object>()),
  verifyEndUserJwt: vi.fn(async () => ({ sub: 'eu' })),
}));
vi.mock('../../services/app-pool.js', async (orig) => ({
  ...(await orig<object>()),
  getAppPoolForApp: vi.fn(async () => ({ fake: 'pool' })),
}));

const { resolveAppAndUser } = await import('../storage.js');
const { resolveAppAndPool } = await import('../auto-api.js');
const { AppPausedError } = await import('../../services/app-resolver.js');

const paused = { id: 'app_1', name: 'a', owner_id: 'u1', db_name: 'd', paused: true, paused_reason: 'r', paused_by: 'idle_reaper' };

beforeEach(() => { resolveApp.mockReset(); resolveAppPublic.mockReset(); });

describe('storage resolveAppAndUser on a paused app', () => {
  const runtimeDb = { query: vi.fn(async () => ({ rows: [{ id: 'app_1', storage_config: {}, paused: true, paused_reason: 'r', paused_by: 'idle_reaper' }] })) };

  it('lets the owner (jwt) through', async () => {
    resolveApp.mockResolvedValue(paused);
    await expect(resolveAppAndUser({} as never, runtimeDb as never, 'app_1', { userId: 'u1', authMethod: 'jwt' } as never))
      .resolves.toBeDefined();
  });

  it('lets the owner (api_key) through', async () => {
    resolveApp.mockResolvedValue(paused);
    await expect(resolveAppAndUser({} as never, runtimeDb as never, 'app_1', { userId: 'u1', authMethod: 'api_key' } as never))
      .resolves.toBeDefined();
  });

  it('still blocks function_key', async () => {
    resolveApp.mockResolvedValue(paused);
    await expect(resolveAppAndUser({} as never, runtimeDb as never, 'app_1', { userId: 'u1', authMethod: 'function_key' } as never))
      .rejects.toBeInstanceOf(AppPausedError);
  });

  it('still blocks end users', async () => {
    await expect(resolveAppAndUser({} as never, runtimeDb as never, 'app_1', { userId: 'eu', authMethod: 'end_user_jwt' } as never))
      .rejects.toBeInstanceOf(AppPausedError);
  });
});

describe('auto-api resolveAppAndPool on a paused app', () => {
  it('lets the owner (jwt) through', async () => {
    resolveApp.mockResolvedValue(paused);
    await expect(resolveAppAndPool({} as never, 'app_1', { userId: 'u1', authMethod: 'jwt' }))
      .resolves.toMatchObject({ role: 'butterbase_service' });
  });

  it('lets the owner (api_key) through', async () => {
    resolveApp.mockResolvedValue(paused);
    await expect(resolveAppAndPool({} as never, 'app_1', { userId: 'u1', authMethod: 'api_key' }))
      .resolves.toMatchObject({ role: 'butterbase_service' });
  });

  it('still blocks function_key', async () => {
    resolveAppPublic.mockResolvedValue(paused);
    await expect(resolveAppAndPool({} as never, 'app_1', { userId: 'u1', authMethod: 'function_key' }))
      .rejects.toBeInstanceOf(AppPausedError);
  });

  it('still blocks end users', async () => {
    resolveAppPublic.mockResolvedValue(paused);
    await expect(resolveAppAndPool({} as never, 'app_1', { userId: 'eu', authMethod: 'end_user_jwt', rawToken: 't' }))
      .rejects.toBeInstanceOf(AppPausedError);
  });
});
