import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Mocks matching the shape of the sibling clone-preflight.test.ts, except
// AUTO_MINT_CONVENTION_KEYS carries the real convention names so the route's
// classify() branch can annotate DO env keys.
vi.mock('../../services/region-resolver.js', () => ({
  resolveAppHomeRegion: vi.fn().mockResolvedValue('us-east-1'),
}));
vi.mock('../../services/runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(),
}));
vi.mock('../../services/clone-env-vars.js', () => ({
  listSourceEnvVarKeys: vi.fn().mockResolvedValue([]),
  detectConventions: vi.fn().mockReturnValue([]),
  AUTO_MINT_CONVENTION_KEYS: ['BUTTERBASE_API_KEY', 'BB_SUBSTRATE_KEY'],
  STATIC_FILL_KEYS: [],
}));
vi.mock('../../services/durable-objects.service.js', () => ({
  listDoEnvVarKeys: vi.fn(),
}));
vi.mock('../../services/crypto.js', () => ({
  encrypt: vi.fn((s: string) => `encrypted_${s}`),
  decrypt: vi.fn((s: string) => s.replace('encrypted_', '')),
}));

import Fastify from 'fastify';
import { cloneRoutesPreflight } from '../clone-preflight.js';
import { getRuntimeDbPool } from '../../services/runtime-db.js';
import { listDoEnvVarKeys } from '../../services/durable-objects.service.js';

describe('GET clone-preflight annotates DO env keys via key_meta', () => {
  let app: FastifyInstance;
  let mockRuntime: { query: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.stubEnv('AUTH_ENCRYPTION_KEY', '00'.repeat(32));
    mockRuntime = { query: vi.fn() };
    (getRuntimeDbPool as any).mockReturnValue(mockRuntime);
    (listDoEnvVarKeys as any).mockReset();

    // Default: source is a public app with no fn/app env vars. Individual
    // tests override the DO env key list via listDoEnvVarKeys mock.
    mockRuntime.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM apps')) {
        return { rows: [{ visibility: 'public', owner_id: 'u_owner' }] };
      }
      return { rows: [] };
    });

    app = Fastify();
    (app as any).controlDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    cloneRoutesPreflight(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('marks BUTTERBASE_API_KEY on the DO side as auto_filled and skips the "must re-set" note', async () => {
    (listDoEnvVarKeys as any).mockResolvedValue(['BUTTERBASE_API_KEY']);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/templates/app_source_x/clone-preflight',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.durable_objects.env_keys).toEqual(['BUTTERBASE_API_KEY']);
    expect(body.durable_objects.key_meta).toEqual([
      {
        key: 'BUTTERBASE_API_KEY',
        status: 'auto_filled',
        reason: 'Auto-minted bb_sk_* scoped to the new app (shared with functions).',
      },
    ]);
    // Note only fires for user_required keys. All keys are auto_filled here,
    // so no leftover "must re-set post-clone" copy — that would be misleading.
    expect(body.durable_objects.note).toBeUndefined();
  });

  it('marks non-convention DO keys as user_required and keeps the re-set note', async () => {
    (listDoEnvVarKeys as any).mockResolvedValue(['CUSTOM_SECRET', 'ANOTHER_KEY']);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/templates/app_source_x/clone-preflight',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.durable_objects.env_keys.sort()).toEqual(['ANOTHER_KEY', 'CUSTOM_SECRET']);
    expect(body.durable_objects.key_meta).toEqual([
      { key: 'CUSTOM_SECRET', status: 'user_required' },
      { key: 'ANOTHER_KEY', status: 'user_required' },
    ]);
    expect(body.durable_objects.note).toMatch(/user_required key/);
  });

  it('mixes classifications when source has both convention and non-convention DO keys', async () => {
    (listDoEnvVarKeys as any).mockResolvedValue(['BB_SUBSTRATE_KEY', 'CUSTOM_SECRET']);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/templates/app_source_x/clone-preflight',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.durable_objects.key_meta).toEqual([
      {
        key: 'BB_SUBSTRATE_KEY',
        status: 'auto_filled',
        reason: 'Auto-minted bb_sk_* scoped to the new app (shared with functions).',
      },
      { key: 'CUSTOM_SECRET', status: 'user_required' },
    ]);
    // Note fires because at least one key is user_required.
    expect(body.durable_objects.note).toMatch(/user_required key/);
  });

  it('emits an empty key_meta and no note when the source has no DO env keys', async () => {
    (listDoEnvVarKeys as any).mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/templates/app_source_x/clone-preflight',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.durable_objects.env_keys).toEqual([]);
    expect(body.durable_objects.key_meta).toEqual([]);
    expect(body.durable_objects.note).toBeUndefined();
  });
});
