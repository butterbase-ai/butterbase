import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiKeyService } from './api-key-service.js';

// Mock the Redis client so unit tests don't hit infra.
vi.mock('./redis.js', () => ({
  getRedisClient: () => ({
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  }),
}));

function makePoolStub(captured: { args?: unknown[] }) {
  return {
    query: vi.fn(async (_sql: string, args: unknown[]) => {
      captured.args = args;
      return { rows: [{ id: 'key_test', name: args[3] }] };
    }),
  } as any;
}

describe('ApiKeyService.generateApiKey scopes', () => {
  let captured: { args?: unknown[] };
  beforeEach(() => { captured = {}; });

  it("keyScope 'account' (default) produces scopes ['*']", async () => {
    await ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k', {
      keyScope: 'account',
    });
    expect(captured.args![4]).toEqual(['*']);
    expect(captured.args![5]).toBe('app');
  });

  it("omitting options entirely defaults to scopes ['*'] and scope 'app'", async () => {
    await ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k');
    expect(captured.args![4]).toEqual(['*']);
    expect(captured.args![5]).toBe('app');
  });

  it("rejects an invalid keyScope value", async () => {
    await expect(
      ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k', {
        keyScope: 'bogus' as any,
      })
    ).rejects.toMatchObject({ code: 'INVALID_KEY_SCOPE' });
  });

  it("keyScope 'app' produces scopes ['app:<id>', 'ai:gateway']", async () => {
    await ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k', {
      keyScope: 'app',
      targetAppId: 'app_abc',
    });
    expect(captured.args![4]).toEqual(['app:app_abc', 'ai:gateway']);
  });

  it("keyScope 'app' + additionalScopes appends in order", async () => {
    await ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k', {
      keyScope: 'app',
      targetAppId: 'app_abc',
      additionalScopes: ['substrate'],
    });
    expect(captured.args![4]).toEqual(['app:app_abc', 'ai:gateway', 'substrate']);
  });

  it.each([
    ['app', 'app', 'app'],
    ['app', 'substrate', 'substrate'],
    ['app', 'both', 'both'],
    ['account', 'app', 'app'],
    ['account', 'substrate', 'substrate'],
    ['account', 'both', 'both'],
  ] as const)(
    "keyScope=%s × substrateAccess=%s sets scope column = %s",
    async (keyScope, substrateAccess, expected) => {
      await ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k', {
        keyScope,
        targetAppId: keyScope === 'app' ? 'app_abc' : undefined,
        substrateAccess,
      });
      expect(captured.args![5]).toBe(expected);
    }
  );

  it("rejects keyScope 'app' without targetAppId", async () => {
    await expect(
      ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k', { keyScope: 'app' })
    ).rejects.toMatchObject({ code: 'TARGET_APP_REQUIRED' });
  });

  it("rejects keyScope 'account' with targetAppId", async () => {
    await expect(
      ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k', {
        keyScope: 'account',
        targetAppId: 'app_abc',
      })
    ).rejects.toMatchObject({ code: 'TARGET_APP_NOT_ALLOWED' });
  });

  it.each([['*'], ['app:foo']])(
    "rejects reserved scope %s in additionalScopes",
    async (bad) => {
      await expect(
        ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k', {
          keyScope: 'app',
          targetAppId: 'app_abc',
          additionalScopes: [bad],
        })
      ).rejects.toMatchObject({ code: 'RESERVED_SCOPE' });
    }
  );

  it("rejects unknown scope strings", async () => {
    await expect(
      ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k', {
        keyScope: 'app',
        targetAppId: 'app_abc',
        additionalScopes: ['totally-made-up'],
      })
    ).rejects.toMatchObject({ code: 'UNKNOWN_SCOPE' });
  });
});
