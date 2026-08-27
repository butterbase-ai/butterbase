import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

describe('GET /v1/templates/:app_id/releases/:n — anonymous projection', () => {
  it('returns a summary and never a function body', async () => {
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
});
