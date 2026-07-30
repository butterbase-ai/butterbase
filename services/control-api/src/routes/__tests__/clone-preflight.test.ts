import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../services/region-resolver.js', () => ({
  resolveAppHomeRegion: vi.fn().mockResolvedValue('us-east-1'),
}));
vi.mock('../../services/runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(),
}));
vi.mock('../../services/clone-env-vars.js', () => ({
  listSourceEnvVarKeys: vi.fn().mockResolvedValue([]),
  detectConventions: vi.fn().mockReturnValue([]),
  AUTO_MINT_CONVENTION_KEYS: [],
  STATIC_FILL_KEYS: [],
}));
vi.mock('../../services/durable-objects.service.js', () => ({
  listDoEnvVarKeys: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../services/crypto.js', () => ({
  encrypt: vi.fn((s: string) => `encrypted_${s}`),
  decrypt: vi.fn((s: string) => s.replace('encrypted_', '')),
}));

import Fastify from 'fastify';
import { cloneRoutesPreflight } from '../clone-preflight.js';
import { getRuntimeDbPool } from '../../services/runtime-db.js';

describe('GET clone-preflight surfaces app_env keys', () => {
  let app: FastifyInstance;
  let mockRuntime: { query: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.stubEnv('AUTH_ENCRYPTION_KEY', '00'.repeat(32));
    mockRuntime = { query: vi.fn() };
    (getRuntimeDbPool as any).mockReturnValue(mockRuntime);

    app = Fastify();
    (app as any).controlDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    cloneRoutesPreflight(app);
    await app.ready();
  });

  afterEach(async () => { await app.close(); });

  it('surfaces app-level env keys under app_env.keys with the expected note', async () => {
    mockRuntime.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM apps')) {
        return { rows: [{ visibility: 'public', owner_id: 'u_owner' }] };
      }
      if (sql.includes('FROM app_env_vars')) {
        return { rows: [{ encrypted_env_vars: 'encrypted_' + JSON.stringify({ STRIPE_SECRET: 'sk', RAG_COLLECTION: 'c1' }) }] };
      }
      return { rows: [] };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/templates/app_source_x/clone-preflight',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.app_env.keys.sort()).toEqual(['RAG_COLLECTION', 'STRIPE_SECRET']);
    expect(body.app_env.note).toMatch(/copied to the clone/);
  });

  it('returns app_env.keys=[] when source has no app-level env vars', async () => {
    mockRuntime.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM apps')) {
        return { rows: [{ visibility: 'public', owner_id: 'u_owner' }] };
      }
      return { rows: [] };
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/templates/app_source_x/clone-preflight',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().app_env.keys).toEqual([]);
  });
});
