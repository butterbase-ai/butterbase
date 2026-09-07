import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../services/runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(() => ({ query: vi.fn(async () => ({ rows: [] })) })),
}));

beforeEach(() => vi.resetModules());

describe('CORS — templates origin', () => {
  it('allows the configured templates origin', async () => {
    process.env.TEMPLATES_URL = 'https://templates.butterbase.ai';
    const corsPlugin = (await import('../plugins/cors.js')).default;
    const app = Fastify();
    await app.register(corsPlugin);
    app.get('/v1/templates', async () => ({ items: [] }));
    await app.ready();

    const res = await app.inject({
      method: 'GET', url: '/v1/templates',
      headers: { origin: 'https://templates.butterbase.ai' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://templates.butterbase.ai');
    await app.close();
  });

  it('still denies an unlisted origin', async () => {
    process.env.TEMPLATES_URL = 'https://templates.butterbase.ai';
    const corsPlugin = (await import('../plugins/cors.js')).default;
    const app = Fastify();
    await app.register(corsPlugin);
    app.get('/v1/templates', async () => ({ items: [] }));
    await app.ready();

    const res = await app.inject({
      method: 'GET', url: '/v1/templates',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});
