/**
 * Subdomain-based API routes.
 *
 * These mirror the existing /v1/:app_id/... and /auth/:app_id/... routes
 * but resolve the app_id from the Host header subdomain instead of URL params.
 *
 * Mapping:
 *   myapp.butterbase.dev/data/:table       → /v1/{app_id}/:table
 *   myapp.butterbase.dev/data/:table/:id   → /v1/{app_id}/:table/:id
 *   myapp.butterbase.dev/fn/:functionName  → /v1/{app_id}/fn/:functionName
 *   myapp.butterbase.dev/auth/signup       → /auth/{app_id}/signup
 *   myapp.butterbase.dev/auth/login        → /auth/{app_id}/login
 *   myapp.butterbase.dev/auth/me           → /auth/{app_id}/me
 *   myapp.butterbase.dev/auth/refresh      → /auth/{app_id}/refresh
 *   myapp.butterbase.dev/auth/logout       → /auth/{app_id}/logout
 *   myapp.butterbase.dev/auth/oauth/:p     → /auth/{app_id}/oauth/:p
 *   myapp.butterbase.dev/storage/upload    → /storage/{app_id}/upload
 *   myapp.butterbase.dev/storage/objects   → /storage/{app_id}/objects
 *   myapp.butterbase.dev/schema            → /v1/{app_id}/schema
 *   myapp.butterbase.dev/schema/apply      → /v1/{app_id}/schema/apply
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

/** Pre-handler that ensures request came via a valid subdomain */
async function requireSubdomain(request: FastifyRequest, reply: FastifyReply) {
  if (!request.subdomainAppId) {
    return reply.code(404).send({ error: 'App not found. Use <app>.butterbase.dev to access your app.' });
  }
}

/**
 * Proxy a subdomain request to the existing internal route.
 *
 * Instead of duplicating business logic, we rewrite the URL and use
 * fastify.inject() to internally dispatch to the existing handlers.
 */
async function proxyToInternal(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  internalPath: string
) {
  const appId = request.subdomainAppId!;
  const fullPath = internalPath.replace('{app_id}', appId);

  // Preserve query string
  const qs = request.raw.url?.includes('?')
    ? '?' + request.raw.url.split('?')[1]
    : '';

  const internalResponse = await app.inject({
    method: request.method as any,
    url: `${fullPath}${qs}`,
    headers: {
      ...request.headers,
      // Override host so internal routes don't see subdomain host
      host: `localhost:${config.port}`,
    },
    payload: request.body as any,
  });

  // Copy status + headers + body
  reply.code(internalResponse.statusCode);
  for (const [key, value] of Object.entries(internalResponse.headers)) {
    if (value) reply.header(key, value);
  }
  return reply.send(internalResponse.rawPayload);
}

export async function subdomainApiRoutes(app: FastifyInstance) {
  if (!config.subdomain.enabled) return;

  const opts = { preHandler: requireSubdomain, config: { public: true } };

  // ── Data CRUD ──
  app.get('/data/:table', opts, async (request, reply) => {
    const { table } = request.params as { table: string };
    return proxyToInternal(app, request, reply, `/v1/{app_id}/${table}`);
  });

  app.get('/data/:table/:id', opts, async (request, reply) => {
    const { table, id } = request.params as { table: string; id: string };
    return proxyToInternal(app, request, reply, `/v1/{app_id}/${table}/${id}`);
  });

  app.post('/data/:table', opts, async (request, reply) => {
    const { table } = request.params as { table: string };
    return proxyToInternal(app, request, reply, `/v1/{app_id}/${table}`);
  });

  app.patch('/data/:table/:id', opts, async (request, reply) => {
    const { table, id } = request.params as { table: string; id: string };
    return proxyToInternal(app, request, reply, `/v1/{app_id}/${table}/${id}`);
  });

  app.delete('/data/:table/:id', opts, async (request, reply) => {
    const { table, id } = request.params as { table: string; id: string };
    return proxyToInternal(app, request, reply, `/v1/{app_id}/${table}/${id}`);
  });

  // ── Functions ──
  app.all('/fn/:functionName', opts, async (request, reply) => {
    const { functionName } = request.params as { functionName: string };
    return proxyToInternal(app, request, reply, `/v1/{app_id}/fn/${functionName}`);
  });

  // ── Schema ──
  app.get('/schema', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/v1/{app_id}/schema`);
  });

  app.post('/schema/apply', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/v1/{app_id}/schema/apply`);
  });

  app.get('/migrations', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/v1/{app_id}/migrations`);
  });

  // ── Auth ──
  app.post('/auth/signup', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/auth/{app_id}/signup`);
  });

  app.post('/auth/login', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/auth/{app_id}/login`);
  });

  app.post('/auth/refresh', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/auth/{app_id}/refresh`);
  });

  app.post('/auth/logout', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/auth/{app_id}/logout`);
  });

  app.get('/auth/me', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/auth/{app_id}/me`);
  });

  app.post('/auth/verify-email', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/auth/{app_id}/verify-email`);
  });

  app.post('/auth/forgot-password', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/auth/{app_id}/forgot-password`);
  });

  app.post('/auth/reset-password', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/auth/{app_id}/reset-password`);
  });

  app.get('/auth/oauth/:provider', opts, async (request, reply) => {
    const { provider } = request.params as { provider: string };
    return proxyToInternal(app, request, reply, `/auth/{app_id}/oauth/${provider}`);
  });

  app.get('/auth/oauth/:provider/callback', opts, async (request, reply) => {
    const { provider } = request.params as { provider: string };
    return proxyToInternal(app, request, reply, `/auth/{app_id}/oauth/${provider}/callback`);
  });

  app.get('/auth/.well-known/jwks.json', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/auth/{app_id}/.well-known/jwks.json`);
  });

  // ── Storage ──
  app.post('/storage/upload', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/storage/{app_id}/upload`);
  });

  app.get('/storage/objects', opts, async (request, reply) => {
    return proxyToInternal(app, request, reply, `/storage/{app_id}/objects`);
  });

  app.get('/storage/download/:objectId', opts, async (request, reply) => {
    const { objectId } = request.params as { objectId: string };
    return proxyToInternal(app, request, reply, `/storage/{app_id}/download/${objectId}`);
  });

  app.delete('/storage/objects/:objectId', opts, async (request, reply) => {
    const { objectId } = request.params as { objectId: string };
    return proxyToInternal(app, request, reply, `/storage/{app_id}/objects/${objectId}`);
  });
}
