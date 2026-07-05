import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

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
import { registerAppEnvRoutes } from './app-env.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';

const appId = 'app_123';
const authHeaders = { authorization: 'Bearer test-token' };

describe('app-level env vars', () => {
  let app: FastifyInstance;
  // In-memory store simulating app_env_vars table rows
  let envVarsStore: Record<string, string> = {};

  beforeEach(async () => {
    // AES-256 needs a 32-byte key; hex string is 64 chars.
    vi.stubEnv('AUTH_ENCRYPTION_KEY', '00'.repeat(32));

    envVarsStore = {};
    app = Fastify();
    app.decorate('controlDb', {});

    (getRuntimeDbForApp as any).mockImplementation(() => {
      const queryFn = vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        const normalised = sql.replace(/\s+/g, ' ').trim();
        // SELECT encrypted_env_vars, updated_at FROM app_env_vars
        if (normalised.includes('FROM app_env_vars')) {
          const stored = envVarsStore[params[0] as string];
          if (!stored) return Promise.resolve({ rows: [] });
          return Promise.resolve({
            rows: [{ encrypted_env_vars: stored, updated_at: new Date().toISOString() }],
          });
        }
        // INSERT INTO app_env_vars (UPSERT)
        if (normalised.startsWith('INSERT INTO app_env_vars')) {
          envVarsStore[params[0] as string] = params[1] as string;
          return Promise.resolve({ rows: [] });
        }
        // SELECT name FROM app_functions
        if (normalised.includes('FROM app_functions')) {
          return Promise.resolve({ rows: [{ name: 'hello' }] });
        }
        return Promise.resolve({ rows: [] });
      });
      return Promise.resolve({ query: queryFn });
    });

    app.register(registerFunctionRoutes);
    app.register(registerAppEnvRoutes);
    await app.ready();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it('GET /v1/:appId/env returns empty when unset', async () => {
    const res = await app.inject({
      method: 'GET', url: `/v1/${appId}/env`, headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ keys: [], updatedAt: null });
  });

  it('PATCH /v1/:appId/env sets keys and returns invalidated function list', async () => {
    // Assumes fixture creates one function "hello" on this app.
    const res = await app.inject({
      method: 'PATCH', url: `/v1/${appId}/env`, headers: authHeaders,
      payload: { envVars: { STRIPE_SECRET: 'sk_test_1', SENTRY_DSN: 'https://x' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.updatedKeys.sort()).toEqual(['SENTRY_DSN', 'STRIPE_SECRET']);
    expect(body.invalidated.functions).toContain('hello');
    expect(body.invalidated.count).toBeGreaterThanOrEqual(1);
    // On the happy path, no cache invalidations should have failed.
    expect(body.invalidated.failed ?? []).toEqual([]);
  });

  it('PATCH with null value deletes the key', async () => {
    await app.inject({ method: 'PATCH', url: `/v1/${appId}/env`, headers: authHeaders,
      payload: { envVars: { A: '1', B: '2' } } });
    const res = await app.inject({ method: 'PATCH', url: `/v1/${appId}/env`, headers: authHeaders,
      payload: { envVars: { A: null } } });
    expect(res.json().updatedKeys.sort()).toEqual(['B']);
  });

  it('PATCH rejects BUTTERBASE_* keys', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/v1/${appId}/env`, headers: authHeaders,
      payload: { envVars: { BUTTERBASE_APP_ID: 'nope' } } });
    expect(res.statusCode).toBe(400);
  });

  it('GET never returns values, only keys', async () => {
    await app.inject({ method: 'PATCH', url: `/v1/${appId}/env`, headers: authHeaders,
      payload: { envVars: { SECRET: 'plaintext-should-never-leak' } } });
    const res = await app.inject({ method: 'GET', url: `/v1/${appId}/env`, headers: authHeaders });
    expect(JSON.stringify(res.json())).not.toContain('plaintext-should-never-leak');
    expect(res.json().keys).toContain('SECRET');
  });
});

describe('Functions Routes - Reserved Key Validation', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // AES-256 needs a 32-byte key; hex string is 64 chars.
    vi.stubEnv('AUTH_ENCRYPTION_KEY', '00'.repeat(32));

    app = Fastify();

    // Create mock controlDb
    app.decorate('controlDb', {});

    // Mock getRuntimeDbForApp (never invoked due to early validation error)
    (getRuntimeDbForApp as any).mockImplementation(() => {
      return Promise.resolve({ query: vi.fn() });
    });

    app.register(registerFunctionRoutes);
    await app.ready();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it('PATCH /v1/:appId/functions/:name/env rejects BUTTERBASE_* keys', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/app_123/functions/hello/env',
      headers: { authorization: 'Bearer test-token' },
      payload: { envVars: { BUTTERBASE_FOO: 'x' } },
    });
    const body = res.json();
    expect(res.statusCode).toBe(400);
    expect(body.error.code).toBe('VALIDATION_INVALID_SCHEMA');
    expect(body.error.message).toContain('BUTTERBASE_FOO');
  });
});
