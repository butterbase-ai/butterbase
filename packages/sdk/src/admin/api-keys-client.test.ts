import { describe, it, expect } from 'vitest';
import { AdminApiKeysClient } from './api-keys-client';

function fakeClient() {
  const calls: any[] = [];
  const fc: any = {
    request: (method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      return Promise.resolve({ id: 'k', key: 'sk_test', name: 'ci', created_at: '2026-01-01' });
    },
  };
  return { fc, calls };
}

describe('AdminApiKeysClient.generate', () => {
  it('back-compat: string arg becomes { name }', async () => {
    const { fc, calls } = fakeClient();
    await new AdminApiKeysClient(fc).generate('ci');
    expect(calls[0]).toMatchObject({
      method: 'POST', path: '/api-keys', body: { name: 'ci' },
    });
  });

  it('object arg forwards scopes', async () => {
    const { fc, calls } = fakeClient();
    await new AdminApiKeysClient(fc).generate({ name: 'ci', scopes: ['schema:read', 'functions:invoke'] });
    expect(calls[0].body).toEqual({ name: 'ci', scopes: ['schema:read', 'functions:invoke'] });
  });

  it('object arg without scopes works', async () => {
    const { fc, calls } = fakeClient();
    await new AdminApiKeysClient(fc).generate({ name: 'ci' });
    expect(calls[0].body).toEqual({ name: 'ci' });
  });
});

describe('AdminApiKeysClient.list/revoke', () => {
  it('list hits GET /api-keys', async () => {
    const { fc, calls } = fakeClient();
    await new AdminApiKeysClient(fc).list();
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api-keys' });
  });

  it('revoke hits DELETE /api-keys/:id', async () => {
    const { fc, calls } = fakeClient();
    await new AdminApiKeysClient(fc).revoke('k_1');
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/api-keys/k_1' });
  });
});
