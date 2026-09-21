import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const adminState = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('../admin-auth.js', () => ({
  requireAdmin: vi.fn(async (_app: unknown, _request: unknown, reply: any) => {
    if (!adminState.isAdmin) {
      reply.code(403).send({ error: 'Not authorized as admin' });
      return null;
    }
    return 'admin-uid';
  }),
}));

import mcpClientsRoutes from './mcp-clients.js';

function makeControlDbMock(rows: any[] = []) {
  const query = vi.fn().mockImplementation(async () => ({ rows, rowCount: rows.length }));
  return { query, connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };
}

async function makeApp(controlDb: any, isAdmin = true) {
  adminState.isAdmin = isAdmin;
  const app = Fastify({ logger: false });
  const fp = (await import('fastify-plugin')).default;
  await app.register(
    fp(async (i: any) => i.decorate('controlDb', controlDb), { name: 'shim' }),
  );
  await app.register(mcpClientsRoutes);
  return app;
}

const AUTH = { authorization: 'Bearer ok' };
const URL_BASE = '/admin/metrics/mcp-clients';

describe('/admin/metrics/mcp-clients', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects non-admin with 403', async () => {
    const app = await makeApp(makeControlDbMock(), false);
    const r = await app.inject({ method: 'GET', url: URL_BASE, headers: AUTH });
    expect(r.statusCode).toBe(403);
  });

  it('returns clients with the OAuth prefix stripped and counts coerced to numbers', async () => {
    const db = makeControlDbMock([
      {
        client: 'Claude Code (butterbase)',
        keys: '143',
        users: '9',
        first_seen: '2026-06-29T00:00:00Z',
        last_seen: '2026-09-20T00:00:00Z',
      },
      {
        client: 'Cursor',
        keys: '1',
        users: '1',
        first_seen: '2026-09-11T00:00:00Z',
        last_seen: '2026-09-11T00:00:00Z',
      },
    ]);
    const app = await makeApp(db);
    const r = await app.inject({ method: 'GET', url: URL_BASE, headers: AUTH });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.clients[0]).toMatchObject({
      client: 'Claude Code (butterbase)',
      keys: 143,
      users: 9,
    });
    expect(body.total_clients).toBe(2);
    expect(body.total_keys).toBe(144);
  });

  it('binds the OAuth key prefix as a parameter and never counts hand-made keys', async () => {
    const db = makeControlDbMock();
    const app = await makeApp(db);
    await app.inject({ method: 'GET', url: URL_BASE, headers: AUTH });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('FROM api_keys');
    // The filter must be present, or dashboard-created keys would be reported
    // as MCP connections.
    expect(sql).toContain('LIKE $1');
    expect(params).toEqual(['OAuth: ']);
  });

  it('joins platform_users to exclude internal emails by default, and skips the join when asked', async () => {
    const dbDefault = makeControlDbMock();
    const appDefault = await makeApp(dbDefault);
    await appDefault.inject({ method: 'GET', url: URL_BASE, headers: AUTH });
    expect(dbDefault.query.mock.calls[0][0]).toContain('JOIN platform_users');

    const dbAll = makeControlDbMock();
    const appAll = await makeApp(dbAll);
    const r = await appAll.inject({
      method: 'GET',
      url: `${URL_BASE}?exclude_internal=0`,
      headers: AUTH,
    });
    expect(dbAll.query.mock.calls[0][0]).not.toContain('JOIN platform_users');
    expect(r.json().exclude_internal).toBe(false);
  });

  it('returns an empty report rather than failing when nobody has connected', async () => {
    const app = await makeApp(makeControlDbMock([]));
    const r = await app.inject({ method: 'GET', url: URL_BASE, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ total_clients: 0, total_keys: 0, clients: [] });
  });
});
