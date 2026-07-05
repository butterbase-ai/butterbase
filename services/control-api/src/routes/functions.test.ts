import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AppResolver
vi.mock('../services/app-resolver.js', () => ({
  AppResolver: {
    resolveApp: vi.fn().mockResolvedValue({ id: 'app_123' }),
  },
}));

// Mock region-resolver
vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(),
}));

// Mock crypto
vi.mock('../services/crypto.js', () => ({
  encrypt: vi.fn((data) => `encrypted_${data}`),
  decrypt: vi.fn((data) => data.replace('encrypted_', '')),
}));

// Mock cache invalidation
vi.mock('../utils/cache-invalidation.js', () => ({
  invalidateFunctionCache: vi.fn().mockResolvedValue({ success: true, attempts: 1 }),
}));

// Mock audit logging
vi.mock('../services/audit/with-audit.js', () => ({
  logFromRequest: vi.fn(),
}));

// Mock require-auth
vi.mock('../utils/require-auth.js', () => ({
  requireUserId: vi.fn(() => 'test-user-id'),
}));

// Mock usage metering
vi.mock('../services/usage-metering.js', () => ({
  incrementUsage: vi.fn(),
}));

// Mock org resolver
vi.mock('../services/org-resolver.js', () => ({
  resolveOrganizationId: vi.fn(),
}));

import Fastify from 'fastify';
import { registerFunctionRoutes } from './functions.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';

describe('Functions Routes - Reserved Key Validation', () => {
  let app: any;

  beforeEach(async () => {
    app = Fastify();

    // Create mock controlDb
    app.decorate('controlDb', {});

    // Mock the runtimeDb to return a function record
    const mockQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('encrypted_env_vars FROM app_functions')) {
        return Promise.resolve({
          rows: [{ encrypted_env_vars: null, id: 'fn_123', name: 'hello' }],
        });
      }
      if (sql.includes('UPDATE app_functions')) {
        return Promise.resolve({
          rows: [{ id: 'fn_123', name: 'hello', updated_at: new Date() }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const mockRuntimeDb = { query: mockQuery };

    // Mock getRuntimeDbForApp to return a Promise that resolves to the mock DB
    (getRuntimeDbForApp as any).mockImplementation((_controlDb: any, _appId: string) => {
      return Promise.resolve(mockRuntimeDb);
    });

    app.register(registerFunctionRoutes);
    await app.ready();
  });

  it('PATCH /v1/:appId/functions/:name/env rejects BUTTERBASE_* keys', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/app_123/functions/hello/env',
      headers: { authorization: 'Bearer test-token' },
      payload: { envVars: { BUTTERBASE_FOO: 'x' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_INVALID_SCHEMA');
    expect(res.json().error.message).toContain('BUTTERBASE_FOO');
  });
});
