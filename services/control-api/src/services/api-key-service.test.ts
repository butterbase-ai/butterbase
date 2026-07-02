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

// The pool stub handles two queries in generateApiKey:
//   1. orgLookup  — SELECT personal_organization_id FROM platform_users ...
//   2. INSERT     — INSERT INTO api_keys ...
// We detect by SQL text so the captured.args always reflects the INSERT params.
const TEST_ORG_ID = 'org_test_1';

function makePoolStub(captured: { args?: unknown[] }) {
  return {
    query: vi.fn(async (sql: string, args: unknown[]) => {
      if (sql.includes('personal_organization_id')) {
        return { rows: [{ personal_organization_id: TEST_ORG_ID }] };
      }
      captured.args = args;
      return { rows: [{ id: 'key_test', name: args[4] }] };
    }),
  } as any;
}

// INSERT param layout after Plan 07 (organization_id) + Plan 10.3 (substrate_organization_id):
//   $1  args[0]  user_id
//   $2  args[1]  organization_id
//   $3  args[2]  key_hash
//   $4  args[3]  key_prefix
//   $5  args[4]  name
//   $6  args[5]  scopes
//   $7  args[6]  scope (dbScope)
//   $8  args[7]  substrate_user_id
//   $9  args[8]  substrate_organization_id (null when scope='app')

describe('ApiKeyService.generateApiKey scopes', () => {
  let captured: { args?: unknown[] };
  beforeEach(() => { captured = {}; });

  it("keyScope 'account' (default) produces scopes ['*']", async () => {
    await ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k', {
      keyScope: 'account',
    });
    expect(captured.args![5]).toEqual(['*']);
    expect(captured.args![6]).toBe('app');
  });

  it("omitting options entirely defaults to scopes ['*'] and scope 'app'", async () => {
    await ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k');
    expect(captured.args![5]).toEqual(['*']);
    expect(captured.args![6]).toBe('app');
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
    expect(captured.args![5]).toEqual(['app:app_abc', 'ai:gateway']);
  });

  it("keyScope 'app' + additionalScopes appends in order", async () => {
    await ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k', {
      keyScope: 'app',
      targetAppId: 'app_abc',
      additionalScopes: ['substrate'],
    });
    expect(captured.args![5]).toEqual(['app:app_abc', 'ai:gateway', 'substrate']);
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
      expect(captured.args![6]).toBe(expected);
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

  it.each([
    ['substrate', TEST_ORG_ID],
    ['both', TEST_ORG_ID],
    ['app', null],
  ] as const)(
    "substrateAccess=%s writes substrate_organization_id=%s",
    async (substrateAccess, expectedOrgId) => {
      await ApiKeyService.generateApiKey(makePoolStub(captured), 'u1', 'k', {
        substrateAccess,
      });
      expect(captured.args![8]).toBe(expectedOrgId);
    }
  );
});
