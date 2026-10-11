import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import type { Pool } from 'pg';
import { autoApiRoutes } from './auto-api.js';
import { ragRoutes } from './rag.js';
import { dispatchBuiltin } from '../services/agent-tools/builtin-dispatcher.js';
import { AppNotFoundError } from '../services/app-resolver.js';

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(), resolve: vi.fn(), resolvePublic: vi.fn(), verifyJwt: vi.fn(),
}));
vi.mock('../services/app-pool.js', () => ({ getAppPoolForApp: mocks.getPool }));
vi.mock('../services/app-resolver.js', async importOriginal => ({
  ...await importOriginal<typeof import('../services/app-resolver.js')>(),
  AppResolver: { resolveApp: mocks.resolve, resolveAppPublic: mocks.resolvePublic },
}));
vi.mock('../services/end-user-auth.js', () => ({ verifyEndUserJwt: mocks.verifyJwt }));
vi.mock('../services/schema-introspector.js', () => ({ introspectSchema: async () => ({ tables: {
  posts: { columns: { id: { type: 'uuid', primaryKey: true }, title: { type: 'text' }, owner_id: { type: 'text' } } },
} }) }));
vi.mock('../services/region-resolver.js', () => ({ getRuntimeDbForApp: async () => ({ query: async () => ({ rows: [] }) }) }));
vi.mock('../services/audit/audit-events-service.js', () => ({ logAuditEvent: async () => {}, logAuditEventFromControlDb: async () => {} }));
vi.mock('../services/s3.js', () => ({ uploadObject: async () => {}, downloadObject: vi.fn() }));
vi.mock('../services/openrouter-gateway.js', () => ({
  proxyEmbedding: async () => ({ json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) }),
  proxyChatCompletion: vi.fn(),
}));

const rowId = '00000000-0000-4000-8000-000000000001';
const collection = { id: rowId, name: 'private-notes', access_mode: 'private', embedding_model: 'fixture', embedding_dimensions: 2 };
const controlPool = { query: vi.fn() } as unknown as Pool;
const customerQueries: Array<{ sql: string; role: string; userId: string | null; values: unknown[] }> = [];
const metadataQueries: string[] = [];
const releases = vi.fn();
let creatingCollection = false;
let app: FastifyInstance;

// The real executeWithRole runs against this guard. Unscoped customer SQL
// throws, so removing a wrapper from an actual route makes the test fail.
function guardedPool(): Pool {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      if (!/^SELECT id, (access_mode|embedding_model, embedding_dimensions) FROM _rag_collections WHERE name = \$1$/.test(sql)) {
        throw new Error(`unscoped customer SQL: ${sql}`);
      }
      metadataQueries.push(sql);
      return { rows: [collection], rowCount: 1 };
    },
    connect: async () => {
      let transaction = false;
      let role: string | null = null;
      let appRole: string | null = null;
      let userId: string | null = null;
      return {
        release: releases,
        query: async (sql: string, values: unknown[] = []) => {
          if (sql === 'BEGIN') { transaction = true; return { rows: [] }; }
          if (sql.startsWith('SET LOCAL ROLE ')) { role = sql.slice('SET LOCAL ROLE '.length); return { rows: [] }; }
          if (sql.startsWith('SET LOCAL app.role')) { appRole = sql.split("'")[1]; return { rows: [] }; }
          if (sql.startsWith('SET LOCAL request.jwt.claim.sub')) { userId = sql.split("'")[1]; return { rows: [] }; }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') { transaction = false; return { rows: [] }; }
          // Policy DDL requires ownership and is intentionally separate.
          if (/^(CREATE|DROP) POLICY/.test(sql.trim())) return { rows: [] };
          if (!transaction || !role || appRole !== role) throw new Error(`customer SQL without RLS context: ${sql}`);
          customerQueries.push({ sql, role, userId, values });
          if (sql.includes('FROM _rag_collections')) {
            const creating = sql === 'SELECT id FROM _rag_collections WHERE name = $1';
            if (creating && creatingCollection) return { rows: [], rowCount: 0 };
            return { rows: [collection], rowCount: 1 };
          }
          if (sql.includes('INSERT INTO _rag_collections')) return { rows: [collection], rowCount: 1 };
          if (sql.includes('COUNT(*)')) return { rows: [], rowCount: 0 };
          return { rows: [{ id: rowId, title: 'visible', content: 'visible', document_id: rowId, score: '0.9' }], rowCount: 1 };
        },
      };
    },
  } as unknown as Pool;
}

beforeEach(async () => {
  vi.clearAllMocks();
  customerQueries.length = 0;
  metadataQueries.length = 0;
  creatingCollection = false;
  mocks.getPool.mockResolvedValue(guardedPool());
  const resolved = { id: 'app_rls', db_name: 'customer_fixture', access_mode: 'public', paused: false };
  mocks.resolve.mockResolvedValue(resolved);
  mocks.resolvePublic.mockResolvedValue(resolved);
  mocks.verifyJwt.mockResolvedValue({ sub: 'user-a' });
  app = Fastify();
  app.decorate('controlDb', controlPool);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async request => {
    const method = request.headers['x-test-auth'] ?? 'end_user_jwt';
    request.auth = method === 'anonymous'
      ? { authMethod: undefined } as any
      : { authMethod: method, userId: method === 'end_user_jwt' ? undefined : 'owner', organizationId: 'org-a', rawToken: 'fixture-token' } as any;
  });
  await autoApiRoutes(app);
  await ragRoutes(app);
});
afterEach(async () => { await app.close(); });

const crud: Array<[string, InjectOptions, number]> = [
  ['list', { method: 'GET', url: '/v1/app_rls/posts' }, 200],
  ['get', { method: 'GET', url: `/v1/app_rls/posts/${rowId}` }, 200],
  ['insert', { method: 'POST', url: '/v1/app_rls/posts', payload: { title: 'new' } }, 201],
  ['update', { method: 'PATCH', url: `/v1/app_rls/posts/${rowId}`, payload: { title: 'changed' } }, 200],
  ['delete', { method: 'DELETE', url: `/v1/app_rls/posts/${rowId}` }, 200],
];

describe('Auto API customer-data boundary', () => {
  for (const [auth, role, userId] of [
    ['end_user_jwt', 'butterbase_user', 'user-a'],
    ['anonymous', 'butterbase_anon', null],
    ['api_key', 'butterbase_service', null],
  ] as const) {
    it.each(crud)(`${auth}: %s executes only in its resolved role`, async (_name, options, status) => {
      const response = await app.inject({ ...options, headers: { 'x-test-auth': auth } });
      expect(response.statusCode).toBe(status);
      expect(customerQueries.length).toBeGreaterThan(0);
      expect(customerQueries.every(q => q.role === role && q.userId === userId)).toBe(true);
      expect(releases).toHaveBeenCalledTimes(1);
    });
  }

  it('rejects invalid end-user JWTs before acquiring a customer pool', async () => {
    mocks.verifyJwt.mockRejectedValue(new Error('invalid JWT fixture'));
    const response = await app.inject({ url: '/v1/app_rls/posts' });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(customerQueries).toEqual([]);
  });

  it('rejects anonymous access to authenticated apps before acquiring a customer pool', async () => {
    mocks.resolvePublic.mockResolvedValue({ id: 'app_rls', db_name: 'fixture', access_mode: 'authenticated' });
    const response = await app.inject({ url: '/v1/app_rls/posts', headers: { 'x-test-auth': 'anonymous' } });
    expect(response.statusCode).toBe(401);
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it('rejects a platform caller outside the app organization before acquiring a customer pool', async () => {
    mocks.resolve.mockRejectedValue(new AppNotFoundError('app_rls'));
    const response = await app.inject({ url: '/v1/app_rls/posts', headers: { 'x-test-auth': 'api_key' } });
    expect(response.statusCode).toBe(404);
    expect(mocks.resolve).toHaveBeenCalledWith(controlPool, 'app_rls', 'owner', 'org-a');
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it('permits role simulation for platform auth after ownership resolution', async () => {
    const response = await app.inject({ url: '/v1/app_rls/posts', headers: {
      'x-test-auth': 'api_key', 'x-butterbase-as-role': 'user', 'x-butterbase-as-user': 'user-b',
    } });
    expect(response.statusCode).toBe(200);
    expect(customerQueries[0]).toMatchObject({ role: 'butterbase_user', userId: 'user-b' });
    expect(mocks.resolve).toHaveBeenCalled();
  });

  it('ignores role simulation from an end-user JWT', async () => {
    const response = await app.inject({ url: '/v1/app_rls/posts', headers: {
      'x-butterbase-as-role': 'service', 'x-butterbase-as-user': 'user-b',
    } });
    expect(response.statusCode).toBe(200);
    expect(customerQueries[0]).toMatchObject({ role: 'butterbase_user', userId: 'user-a' });
  });
});

const ragReads: Array<[string, InjectOptions, number]> = [
  ['list collections', { url: '/v1/app_rls/rag/collections' }, 200],
  ['get collection', { url: '/v1/app_rls/rag/collections/private-notes' }, 200],
  ['list documents', { url: '/v1/app_rls/rag/collections/private-notes/documents' }, 200],
  ['get document', { url: `/v1/app_rls/rag/collections/private-notes/documents/${rowId}` }, 200],
  ['delete document', { method: 'DELETE', url: `/v1/app_rls/rag/collections/private-notes/documents/${rowId}` }, 204],
  ['query chunks', { method: 'POST', url: '/v1/app_rls/rag/collections/private-notes/query', payload: { query: 'notes' } }, 200],
];

describe('RAG customer-data boundary', () => {
  it('attributes end-user ingestion to the verified user while explicitly using the service write role', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/app_rls/rag/collections/private-notes/ingest', payload: { text: 'fixture text' },
    });
    expect(response.statusCode).toBe(202);
    const insert = customerQueries.find(q => q.sql.includes('INSERT INTO _rag_documents'));
    expect(insert).toMatchObject({ role: 'butterbase_service', userId: null });
    expect(insert?.values[6]).toBe('user-a');
    expect(mocks.verifyJwt).toHaveBeenCalledWith(controlPool, 'app_rls', 'fixture-token');
  });

  for (const [auth, role, userId] of [
    ['end_user_jwt', 'butterbase_user', 'user-a'], ['api_key', 'butterbase_service', null],
  ] as const) {
    it.each(ragReads)(`${auth}: %s executes in its resolved role`, async (_name, options, status) => {
      const response = await app.inject({ ...options, headers: { 'x-test-auth': auth } });
      expect(response.statusCode).toBe(status);
      expect(customerQueries.length).toBeGreaterThan(0);
      expect(customerQueries.every(q => q.role === role && q.userId === userId)).toBe(true);
    });
  }

  it.each(ragReads)('rejects function keys on %s without touching a customer pool', async (_name, options) => {
    const response = await app.inject({ ...options, headers: { 'x-test-auth': 'function_key' } });
    expect(response.statusCode).toBe(401);
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it.each([
    [{ method: 'POST', url: '/v1/app_rls/rag/collections', payload: { name: 'private-notes' } }, 201],
    [{ method: 'DELETE', url: '/v1/app_rls/rag/collections/private-notes' }, 204],
    [{ method: 'POST', url: '/v1/app_rls/rag/collections/private-notes/ingest', payload: { text: 'fixture text' } }, 202],
  ] as Array<[InjectOptions, number]>)('wraps service-level RAG writes: %j', async (options, status) => {
    creatingCollection = true;
    const response = await app.inject({ ...options, headers: { 'x-test-auth': 'api_key' } });
    expect(response.statusCode).toBe(status);
    expect(customerQueries.length).toBeGreaterThan(0);
    expect(customerQueries.every(q => q.role === 'butterbase_service' && q.userId === null)).toBe(true);
  });
});

describe('agent builtin customer-data boundary', () => {
  const tools: Array<[string, Record<string, unknown>]> = [
    ['query_table', { table: 'posts' }], ['insert_row', { table: 'posts', values: { title: 'new' } }],
    ['update_row', { table: 'posts', id: rowId, patch: { title: 'changed' } }], ['delete_row', { table: 'posts', id: rowId }],
  ];
  for (const callerKind of ['end_user', 'function', 'dashboard'] as const) {
    it.each(tools)(`${callerKind}: %s cannot issue unscoped customer SQL`, async (tool, args) => {
      const result = await dispatchBuiltin(tool, args, { appId: 'app_rls', runId: 'run-fixture', callerKind, callerUserId: 'user-a' }, controlPool);
      expect(result.ok).toBe(true);
      expect(customerQueries).toHaveLength(1);
      expect(customerQueries[0]).toMatchObject({
        role: callerKind === 'end_user' ? 'butterbase_user' : 'butterbase_service',
        userId: callerKind === 'end_user' ? 'user-a' : null,
      });
    });
  }
  it('uses an explicit service role for the privileged auth lookup builtin', async () => {
    const result = await dispatchBuiltin('auth_user_lookup', { id: rowId }, {
      appId: 'app_rls', runId: 'run-fixture', callerKind: 'dashboard', callerUserId: 'owner',
    }, controlPool);
    expect(result.ok).toBe(true);
    expect(customerQueries[0]).toMatchObject({ role: 'butterbase_service', userId: null });
  });
});
