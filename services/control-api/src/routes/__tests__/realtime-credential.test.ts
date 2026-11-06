import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/end-user-auth.js', () => ({ verifyEndUserJwt: vi.fn() }));
vi.mock('../../services/api-key-service.js', () => ({
  ApiKeyService: { validateApiKey: vi.fn() },
}));
vi.mock('../../plugins/pause-gate.js', () => ({ assertAppIdNotPaused: vi.fn() }));

const { realtimeCredential, resolveRealtimeAuth } = await import('../realtime.js');
const { verifyEndUserJwt } = await import('../../services/end-user-auth.js');
const { ApiKeyService } = await import('../../services/api-key-service.js');
const { AppResolver, AppAuthRequiredError } = await import('../../services/app-resolver.js');

const app = 'app_fixture';

function request(
  headers: Record<string, string>,
  query: Record<string, unknown> = {},
  rawHeaders?: string[]
) {
  return {
    headers,
    query,
    raw: { rawHeaders: rawHeaders ?? Object.entries(headers).flat() },
  } as never;
}

describe('realtimeCredential', () => {
  it('accepts a native Authorization header, which the public route never sees via request.auth', () => {
    expect(realtimeCredential(request({ authorization: 'Bearer header-token' }))).toBe('header-token');
  });

  it('keeps the browser query-token path working', () => {
    expect(realtimeCredential(request({}, { token: 'query-token' }))).toBe('query-token');
    expect(realtimeCredential(request({}, {}))).toBeUndefined();
  });

  it('fails closed for ambiguous, duplicated or malformed credentials', () => {
    expect(() => realtimeCredential(request({ authorization: 'Bearer a' }, { token: 'b' }))).toThrow();
    expect(() => realtimeCredential(request({ authorization: 'Bearer a' }, {}, ['authorization', 'Bearer a', 'authorization', 'Bearer b']))).toThrow();
    expect(() => realtimeCredential(request({ authorization: 'Basic abc' }))).toThrow();
    expect(() => realtimeCredential(request({}, { token: 'has space' }))).toThrow();
  });
});

describe('resolveRealtimeAuth', () => {
  const controlDb = {} as never;
  const workingApp = { id: app, db_name: 'db_fixture', access_mode: 'authenticated' } as never;

  beforeEach(() => {
    vi.mocked(ApiKeyService.validateApiKey).mockReset();
    vi.mocked(verifyEndUserJwt).mockReset();
  });

  it('authorizes an end-user token carried in the header as butterbase_user', async () => {
    vi.mocked(verifyEndUserJwt).mockResolvedValue({ sub: 'user-1', app_id: app, exp: 1 } as never);
    vi.spyOn(AppResolver, 'resolveAppPublic').mockResolvedValue(workingApp);
    await expect(resolveRealtimeAuth(controlDb, app, 'header-token')).resolves.toEqual({
      dbName: 'db_fixture', role: 'butterbase_user', userId: 'user-1',
    });
    expect(verifyEndUserJwt).toHaveBeenCalledWith(controlDb, app, 'header-token');
  });

  it('rejects a token whose claims do not belong to this app', async () => {
    vi.mocked(verifyEndUserJwt).mockResolvedValue({ sub: 'user-1', app_id: 'app_other', exp: 1 } as never);
    await expect(resolveRealtimeAuth(controlDb, app, 'header-token')).rejects.toThrow('Invalid realtime end-user identity');
  });

  it('authorizes a validated app-scoped service key as butterbase_service', async () => {
    vi.mocked(ApiKeyService.validateApiKey).mockResolvedValue({
      userId: 'owner-1', authMethod: 'api_key', keyId: 'key-1', organizationId: null, scopes: [`app:${app}`],
    } as never);
    vi.spyOn(AppResolver, 'resolveApp').mockResolvedValue(workingApp);
    await expect(resolveRealtimeAuth(controlDb, app, 'bb_sk_fixture')).resolves.toEqual({
      dbName: 'db_fixture', role: 'butterbase_service', userId: null,
    });
  });

  it('does not create a service identity from an unvalidated key', async () => {
    vi.mocked(ApiKeyService.validateApiKey).mockResolvedValue(null as never);
    await expect(resolveRealtimeAuth(controlDb, app, 'bb_sk_fixture')).rejects.toThrow();
  });

  it('still refuses anonymous access to an authenticated app', async () => {
    vi.spyOn(AppResolver, 'resolveAppPublic').mockResolvedValue(workingApp);
    await expect(resolveRealtimeAuth(controlDb, app, undefined)).rejects.toBeInstanceOf(AppAuthRequiredError);
  });
});
