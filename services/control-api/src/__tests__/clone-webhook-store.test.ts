import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('clone-webhook-store', () => {
  const fakeKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    process.env.AUTH_ENCRYPTION_KEY = fakeKey;
  });

  it('upsertCloneWebhook stores an encrypted secret', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [{ app_id: 'app_x' }] });
    const db = { query: queryMock };
    const { upsertCloneWebhook } = await import('../services/clone-webhook-store.js');

    await upsertCloneWebhook(db as any, 'app_x', 'https://example.com/hook', 'raw-secret');

    expect(queryMock).toHaveBeenCalledOnce();
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('INSERT INTO app_clone_webhooks');
    // stored secret must NOT be the plaintext
    expect(params[2]).not.toBe('raw-secret');
    // stored secret should look like iv:ciphertext:tag (base64 segments separated by ':')
    expect(params[2]).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  });

  it('getCloneWebhook returns null when no row exists', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const { getCloneWebhook } = await import('../services/clone-webhook-store.js');
    const result = await getCloneWebhook(db as any, 'app_x');
    expect(result).toBeNull();
  });

  it('getCloneWebhook decrypts the secret', async () => {
    const { encrypt } = await import('../services/crypto.js');
    const encrypted = encrypt('my-secret', fakeKey);
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ app_id: 'app_x', webhook_url: 'https://example.com/hook', webhook_secret_encrypted: encrypted }],
      }),
    };
    const { getCloneWebhook } = await import('../services/clone-webhook-store.js');
    const result = await getCloneWebhook(db as any, 'app_x');
    expect(result?.webhook_url).toBe('https://example.com/hook');
    expect(result?.webhook_secret).toBe('my-secret');
  });

  it('deleteCloneWebhook sends correct DELETE', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    const db = { query: queryMock };
    const { deleteCloneWebhook } = await import('../services/clone-webhook-store.js');
    await deleteCloneWebhook(db as any, 'app_x');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('DELETE FROM app_clone_webhooks');
    expect(params[0]).toBe('app_x');
  });
});
