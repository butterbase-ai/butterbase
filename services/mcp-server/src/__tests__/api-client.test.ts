import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet } from '../api-client.js';
import { runWithRequestAuthorizationHeader } from '../request-auth-context.js';

describe('API Client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('forwards request-scoped Authorization header when present', async () => {
    process.env.BUTTERBASE_API_KEY = 'bb_sk_service_fallback';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ apps: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runWithRequestAuthorizationHeader('Bearer user_token_123', async () => {
      await apiGet('/apps');
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer user_token_123',
    });
  });

  it('falls back to BUTTERBASE_API_KEY when request token is absent', async () => {
    process.env.BUTTERBASE_API_KEY = 'bb_sk_service_fallback';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ apps: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await apiGet('/apps');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer bb_sk_service_fallback',
    });
  });

  it('sends no Authorization header when neither request token nor env key exists', async () => {
    delete process.env.BUTTERBASE_API_KEY;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ apps: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await apiGet('/apps');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
