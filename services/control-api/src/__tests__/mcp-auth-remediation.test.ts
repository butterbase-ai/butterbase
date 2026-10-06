import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { wellKnownRoutes } from '../routes/well-known.js';

/**
 * The unauthenticated MCP 401 is the first thing any new client sees — including
 * marketplace reviewers evaluating Butterbase as a connector. It must not name a
 * specific vendor's client, and it must point at setup docs that resolve.
 */
describe('MCP auth-required remediation', () => {
  it('does not name a specific third-party client', async () => {
    const { default: fs } = await import('node:fs/promises');
    const src = await fs.readFile(new URL('../plugins/auth.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('function mcpAuthRequiredBody'));
    const remediation = body.slice(0, body.indexOf('documentation_url'));

    for (const vendor of ['Claude Code', 'claude mcp add', 'Cursor', 'Windsurf', 'Qoder']) {
      expect(remediation).not.toContain(vendor);
    }
  });

  it('points at a docs path that the docs site actually serves', async () => {
    const app = Fastify({ logger: false });
    await app.register(wellKnownRoutes);
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    // Bare /mcp and /schema were both 404 on the live docs site; anything that is
    // not a real published path should fail here rather than in a reviewer's browser.
    expect(res.json().resource_documentation).not.toMatch(/docs\.butterbase\.ai\/(mcp|schema)$/);
    await app.close();
  });
});
