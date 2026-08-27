import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

describe('GET /v1/templates/:app_id/releases/:n — anonymous projection', () => {
  it('returns a summary and never a function body', async () => {
    // The anonymous route now gates on the app being visibility='public'
    // (FIX 3) — stub the region lookup it uses to check that.
    vi.doMock('../services/region-resolver.js', async () => ({
      getRuntimeDbForApp: async () => ({
        query: async () => ({ rows: [{ visibility: 'public' }] }),
      }),
    }));
    vi.doMock('../services/template-releases.js', async () => ({
      getRelease: async () => ({
        id: 'rel_1', source_app_id: 'app_src', release_number: 1,
        label: 'v1', snapshot_id: 'snap', notes: null,
        published_by: 'usr', published_at: new Date(),
        manifest: {
          schema: { tables: { todos: { columns: {} } } },
          functions: [{ name: 'webhook', code: 'BODY_MUST_NOT_LEAK' }],
          required_env: { functions: {}, durable_objects: [] },
          rls: [], config: {}, durable_objects: [],
          hashes: { schema: 'a', rls: 'b', functions: 'c', config: 'd' },
        },
      }),
      summarizeRelease: (await vi.importActual<typeof import('../services/template-releases.js')>(
        '../services/template-releases.js')).summarizeRelease,
      listReleases: async () => [],
      publishRelease: async () => { throw new Error('unused'); },
      updateReleaseText: async () => null,
      NoRepoSnapshotError: class extends Error {},
    }));

    const { templateReleaseRoutes } = await import('../routes/template-releases.js');
    const app = Fastify();
    app.decorate('controlDb', { query: async () => ({ rows: [] }) } as any);
    templateReleaseRoutes(app);

    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_src/releases/1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('BODY_MUST_NOT_LEAK');
    expect(JSON.parse(res.body).table_count).toBe(1);
    await app.close();
  });

  it('404s a private app instead of leaking its release detail (FIX 3)', async () => {
    vi.resetModules();
    vi.doMock('../services/region-resolver.js', async () => ({
      getRuntimeDbForApp: async () => ({
        query: async () => ({ rows: [{ visibility: 'private' }] }),
      }),
    }));
    vi.doMock('../services/template-releases.js', async () => ({
      getRelease: async () => { throw new Error('getRelease must not be called for a private app'); },
      summarizeRelease: (await vi.importActual<typeof import('../services/template-releases.js')>(
        '../services/template-releases.js')).summarizeRelease,
      listReleases: async () => [],
      publishRelease: async () => { throw new Error('unused'); },
      updateReleaseText: async () => null,
      NoRepoSnapshotError: class extends Error {},
    }));

    const { templateReleaseRoutes } = await import('../routes/template-releases.js');
    const app = Fastify();
    app.decorate('controlDb', { query: async () => ({ rows: [] }) } as any);
    templateReleaseRoutes(app);

    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_src/releases/1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it.each([
    ['non-numeric', 'abc'],
    ['negative', '-1'],
    ['zero', '0'],
  ])('rejects a %s release number with 400, never 500 or 404', async (_label, badN) => {
    vi.resetModules();
    vi.doMock('../services/template-releases.js', async () => ({
      // Proves the malformed param is rejected before touching the DB layer —
      // if this were called with NaN/negative, the test itself would fail.
      getRelease: async () => { throw new Error('getRelease must not be called for an invalid release number'); },
      summarizeRelease: (await vi.importActual<typeof import('../services/template-releases.js')>(
        '../services/template-releases.js')).summarizeRelease,
      listReleases: async () => [],
      publishRelease: async () => { throw new Error('unused'); },
      updateReleaseText: async () => null,
      NoRepoSnapshotError: class extends Error {},
    }));

    const { templateReleaseRoutes } = await import('../routes/template-releases.js');
    const app = Fastify();
    app.decorate('controlDb', { query: async () => ({ rows: [] }) } as any);
    templateReleaseRoutes(app);

    const res = await app.inject({ method: 'GET', url: `/v1/templates/app_src/releases/${badN}` });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('VALIDATION_INVALID_SCHEMA');
    await app.close();
  });
});

describe('GET /v1/templates/:app_id/releases — anonymous changelog (FIX 3)', () => {
  function mockDeps(visibility: string | null) {
    vi.resetModules();
    vi.doMock('../services/region-resolver.js', async () => ({
      getRuntimeDbForApp: async () => ({
        query: async () => ({ rows: visibility === null ? [] : [{ visibility }] }),
      }),
    }));
    vi.doMock('../services/template-releases.js', async () => ({
      getRelease: async () => { throw new Error('unused'); },
      summarizeRelease: (v: unknown) => v,
      listReleases: async () => [{ release_number: 1, label: 'v1' }],
      publishRelease: async () => { throw new Error('unused'); },
      updateReleaseText: async () => null,
      NoRepoSnapshotError: class extends Error {},
    }));
  }

  it('serves the changelog for a public template', async () => {
    mockDeps('public');
    const { templateReleaseRoutes } = await import('../routes/template-releases.js');
    const app = Fastify();
    app.decorate('controlDb', { query: async () => ({ rows: [] }) } as any);
    templateReleaseRoutes(app);
    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_src/releases' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).items).toHaveLength(1);
    await app.close();
  });

  it('404s the changelog for a private app instead of leaking release notes / function names / env keys', async () => {
    mockDeps('private');
    const { templateReleaseRoutes } = await import('../routes/template-releases.js');
    const app = Fastify();
    app.decorate('controlDb', { query: async () => ({ rows: [] }) } as any);
    templateReleaseRoutes(app);
    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_src/releases' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('404s the changelog for an unknown app id (not a leaked 403/500)', async () => {
    mockDeps(null);
    const { templateReleaseRoutes } = await import('../routes/template-releases.js');
    const app = Fastify();
    app.decorate('controlDb', { query: async () => ({ rows: [] }) } as any);
    templateReleaseRoutes(app);
    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_ghost/releases' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('lets an authenticated org member list releases for their own non-public app (regression)', async () => {
    // The regression this guards: the LIST route gated on visibility unconditionally
    // and never checked org membership, so an owner publishing releases on their own
    // private app (POST gates on AppResolver.resolveApp only, not visibility) could
    // not then list them. The DETAIL route already had this bypass; LIST didn't.
    mockDeps('private');
    vi.doMock('../services/app-resolver.js', async () => ({
      AppResolver: { resolveApp: async () => ({ id: 'app_src', db_name: 'db_src' }) },
    }));

    const { templateReleaseRoutes } = await import('../routes/template-releases.js');
    const app = Fastify();
    app.decorate('controlDb', { query: async () => ({ rows: [] }) } as any);
    app.decorateRequest('auth', null as any);
    app.addHook('onRequest', async (request: any) => {
      request.auth = { userId: 'user_member', organizationId: 'org_1', authMethod: 'session', scopes: ['*'] };
    });
    templateReleaseRoutes(app);

    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_src/releases' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).items).toHaveLength(1);
    await app.close();
  });

  it('still 404s a private app for an authenticated caller who is NOT a member (resolveApp rejects)', async () => {
    mockDeps('private');
    vi.doMock('../services/app-resolver.js', async () => ({
      AppResolver: { resolveApp: async () => { throw new Error('not a member'); } },
    }));

    const { templateReleaseRoutes } = await import('../routes/template-releases.js');
    const app = Fastify();
    app.decorate('controlDb', { query: async () => ({ rows: [] }) } as any);
    app.decorateRequest('auth', null as any);
    app.addHook('onRequest', async (request: any) => {
      request.auth = { userId: 'user_stranger', organizationId: 'org_2', authMethod: 'session', scopes: ['*'] };
    });
    templateReleaseRoutes(app);

    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_src/releases' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
