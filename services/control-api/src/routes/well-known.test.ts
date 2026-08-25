import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { wellKnownRoutes } from './well-known.js';

async function buildAppForTest() {
  const app = Fastify({ logger: false });
  await app.register(wellKnownRoutes);
  return app;
}

describe('GET /.well-known/oauth-protected-resource', () => {
  it('returns the resource metadata', async () => {
    const app = await buildAppForTest();
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resource).toMatch(/\/mcp$/);
    expect(body.authorization_servers).toHaveLength(1);
    expect(body.bearer_methods_supported).toContain('header');
    await app.close();
  });

  // A 404 here is invisible in prod but is the first link an MCP client — or a
  // marketplace reviewer — follows from discovery. Pin the path so a docs-site
  // reshuffle has to update it deliberately.
  it('advertises a resource_documentation path that exists on the docs site', async () => {
    const app = await buildAppForTest();
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(res.json().resource_documentation).toBe(
      'https://docs.butterbase.ai/getting-started/mcp-setup/',
    );
    await app.close();
  });

  it('is reachable without an Authorization header', async () => {
    const app = await buildAppForTest();
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('GET /.well-known/oauth-authorization-server', () => {
  it('advertises PKCE S256 and authorization_code grant', async () => {
    const app = await buildAppForTest();
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.grant_types_supported).toContain('authorization_code');
    expect(body.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(body.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
    expect(body.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none']);
    await app.close();
  });
});
