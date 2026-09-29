import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import helmetPlugin from '../plugins/helmet.js';
import { notificationActionsRoutes } from './notification-actions.js';

// The global helmet CSP is `default-src 'none'` (API-only), which blocks the
// inline styles on the email one-click result page. That page — and only that
// page — must allow inline styles while keeping everything else locked down.
async function build() {
  const app = Fastify();
  await app.register(helmetPlugin);
  app.decorate('controlDb', {} as never);
  await app.register(notificationActionsRoutes);
  app.get('/json', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('notification action page CSP', () => {
  it('allows inline styles on the HTML result page', async () => {
    const app = await build();
    const r = await app.inject({ method: 'GET', url: '/v1/notif/action/not-a-valid-token!' });
    expect(r.statusCode).toBe(400);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src/);
    await app.close();
  });

  it('leaves the strict API CSP on other routes', async () => {
    const app = await build();
    const r = await app.inject({ method: 'GET', url: '/json' });
    expect(String(r.headers['content-security-policy'])).not.toContain('style-src');
    await app.close();
  });
});
