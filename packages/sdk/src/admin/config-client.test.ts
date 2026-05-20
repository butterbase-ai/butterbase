import { describe, it, expect, expectTypeOf } from 'vitest';
import { AdminConfigClient } from './config-client';
import type { JwtConfig, CorsConfig, StorageConfig } from './types';

describe('AdminConfigClient.updateAccessMode', () => {
  it('parameter type only accepts the two backend modes', () => {
    expectTypeOf<Parameters<AdminConfigClient['updateAccessMode']>[0]>()
      .toEqualTypeOf<'public' | 'authenticated'>();
  });

  it('sends access_mode in PATCH body', async () => {
    const calls: any[] = [];
    const fakeClient: any = {
      appId: 'app_x',
      request: (method: string, path: string, body: any) => {
        calls.push({ method, path, body });
        return Promise.resolve({ message: 'ok', app_id: 'app_x', access_mode: 'public' });
      },
    };
    const c = new AdminConfigClient(fakeClient);
    await c.updateAccessMode('public');
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/v1/app_x/config/access-mode',
      body: { access_mode: 'public' },
    });
  });
});

describe('JwtConfig', () => {
  it('has backend-shaped optional fields', () => {
    const j: JwtConfig = { accessTokenTtl: '15m', refreshTokenTtlDays: 30 };
    expect(j.accessTokenTtl).toBe('15m');
    expect(j.refreshTokenTtlDays).toBe(30);
  });

  it('allows partial config (either field on its own)', () => {
    const a: JwtConfig = { accessTokenTtl: '1h' };
    const b: JwtConfig = { refreshTokenTtlDays: 7 };
    expect(a.refreshTokenTtlDays).toBeUndefined();
    expect(b.accessTokenTtl).toBeUndefined();
  });
});

describe('AdminConfigClient.updateJwt', () => {
  it('forwards JwtConfig body to PATCH /v1/:app/config/jwt', async () => {
    const calls: any[] = [];
    const fakeClient: any = {
      appId: 'app_x',
      request: (method: string, path: string, body: any) => {
        calls.push({ method, path, body });
        return Promise.resolve({});
      },
    };
    const c = new AdminConfigClient(fakeClient);
    await c.updateJwt({ accessTokenTtl: '15m', refreshTokenTtlDays: 30 });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/v1/app_x/config/jwt',
      body: { accessTokenTtl: '15m', refreshTokenTtlDays: 30 },
    });
  });
});

describe('CorsConfig (expanded)', () => {
  it('accepts the four backend camelCase fields', () => {
    const c: CorsConfig = {
      allowedOrigins: ['https://app.example'],
      allowedMethods: ['GET', 'POST'],
      allowedHeaders: ['content-type', 'authorization'],
      allowCredentials: true,
    };
    expect(c.allowedOrigins?.[0]).toBe('https://app.example');
  });

  it('still accepts the deprecated snake_case allowed_origins', () => {
    const c: CorsConfig = { allowed_origins: ['https://app.example'] };
    expect(c.allowed_origins?.[0]).toBeDefined();
  });
});

describe('StorageConfig (expanded)', () => {
  it('accepts publicReadEnabled, maxFileSizeMb, allowedContentTypes', () => {
    const s: StorageConfig = {
      publicReadEnabled: true,
      maxFileSizeMb: 25,
      allowedContentTypes: ['image/png', 'image/jpeg'],
    };
    expect(s.maxFileSizeMb).toBe(25);
  });

  it('updateStorage forwards body verbatim', async () => {
    const calls: any[] = [];
    const fakeClient: any = {
      appId: 'app_x',
      request: (method: string, path: string, body: any) => {
        calls.push({ method, path, body });
        return Promise.resolve({});
      },
    };
    const c = new AdminConfigClient(fakeClient);
    await c.updateStorage({ publicReadEnabled: true, maxFileSizeMb: 100 });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/v1/app_x/config/storage',
      body: { publicReadEnabled: true, maxFileSizeMb: 100 },
    });
  });

  it('updateCors forwards camelCase body verbatim', async () => {
    const calls: any[] = [];
    const fakeClient: any = {
      appId: 'app_x',
      request: (method: string, path: string, body: any) => {
        calls.push({ method, path, body });
        return Promise.resolve({});
      },
    };
    const c = new AdminConfigClient(fakeClient);
    await c.updateCors({ allowedOrigins: ['https://x'], allowCredentials: false });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/v1/app_x/config/cors',
      body: { allowedOrigins: ['https://x'], allowCredentials: false },
    });
  });
});

describe('CorsConfig and StorageConfig imports', () => {
  it('exports are available', () => {
    expectTypeOf<CorsConfig>().toBeObject();
    expectTypeOf<StorageConfig>().toBeObject();
  });
});
