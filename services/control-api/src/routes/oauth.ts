import type { FastifyInstance } from 'fastify';
import { OAuthClientService } from '../services/oauth-client-service.js';
import { OAuthStateService } from '../services/oauth-state-service.js';
import { OAuthCodeService } from '../services/oauth-code-service.js';
import { config } from '../config.js';

const ALLOWED_SCOPES = new Set(['mcp', 'ai:gateway']);

export async function oauthRoutes(app: FastifyInstance) {
  app.route({
    method: 'POST',
    url: '/oauth/register',
    config: { public: true },
    handler: async (request, reply) => {
      const body = (request.body ?? {}) as { client_name?: unknown; redirect_uris?: unknown };
      const redirect_uris = body.redirect_uris;
      const client_name = body.client_name;
      if (!Array.isArray(redirect_uris)) {
        return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required and must be an array' });
      }
      try {
        const out = await OAuthClientService.register(app.controlDb, {
          redirect_uris: redirect_uris as string[],
          client_name: typeof client_name === 'string' ? client_name : undefined,
        });
        return reply.code(201).send({
          client_id: out.client_id,
          client_name: out.client_name,
          redirect_uris: out.redirect_uris,
          client_id_issued_at: Math.floor(out.created_at.getTime() / 1000),
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
          response_types: ['code'],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'invalid request';
        return reply.code(400).send({ error: 'invalid_client_metadata', error_description: message });
      }
    },
  });

  app.route({
    method: 'GET',
    url: '/oauth/authorize',
    config: { public: true },
    handler: async (request, reply) => {
      const q = request.query as Record<string, string | undefined>;

      if (q.response_type !== 'code') {
        return reply.code(400).send({ error: 'unsupported_response_type', error_description: 'response_type must be "code"' });
      }
      if (q.code_challenge_method !== 'S256') {
        return reply.code(400).send({ error: 'invalid_request', error_description: 'code_challenge_method must be S256' });
      }
      if (!q.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) {
        return reply.code(400).send({ error: 'invalid_request', error_description: 'code_challenge missing or malformed' });
      }
      if (!q.client_id || !q.redirect_uri || !q.scope || !q.state) {
        return reply.code(400).send({ error: 'invalid_request', error_description: 'client_id, redirect_uri, scope, state are required' });
      }
      const scopes = q.scope.split(/\s+/).filter(Boolean);
      for (const s of scopes) {
        if (!ALLOWED_SCOPES.has(s)) {
          return reply.code(400).send({ error: 'invalid_scope', error_description: `scope "${s}" is not supported` });
        }
      }
      const client = await OAuthClientService.lookup(app.controlDb, q.client_id);
      if (!client) {
        return reply.code(400).send({ error: 'invalid_request', error_description: 'unknown client_id' });
      }
      if (!client.redirect_uris.includes(q.redirect_uri)) {
        return reply.code(400).send({ error: 'invalid_request', error_description: 'redirect_uri is not registered for this client' });
      }

      const st = OAuthStateService.sign({
        client_id: q.client_id,
        redirect_uri: q.redirect_uri,
        scope: q.scope,
        state: q.state,
        code_challenge: q.code_challenge,
      });

      const dashboardUrl = config.dashboardUrl ?? 'http://localhost:5173';
      const target = new URL('/oauth/consent', dashboardUrl);
      target.searchParams.set('st', st);
      return reply.code(302).header('location', target.toString()).send();
    },
  });

  app.route({
    method: 'GET',
    url: '/oauth/authorize/details',
    handler: async (request, reply) => {
      const st = (request.query as Record<string, string | undefined>).st;
      const payload = st ? OAuthStateService.verify(st) : null;
      if (!payload) {
        return reply.code(400).send({ error: 'invalid_request', error_description: 'invalid or expired state' });
      }
      if (!request.auth?.userId) {
        return reply.code(401).send({ error: 'login_required' });
      }

      const client = await OAuthClientService.lookup(app.controlDb, payload.client_id);
      if (!client) {
        return reply.code(400).send({ error: 'invalid_request', error_description: 'unknown client_id' });
      }

      const apps = await app.controlDb.query<{ id: string; name: string }>(
        `SELECT id, name FROM apps WHERE owner_id = $1 ORDER BY created_at DESC`,
        [request.auth.userId]
      );

      return reply.send({
        client_name: client.client_name,
        redirect_uri: payload.redirect_uri,
        scope: payload.scope,
        apps: apps.rows,
      });
    },
  });

  app.route({
    method: 'POST',
    url: '/oauth/authorize/decide',
    handler: async (request, reply) => {
      if (!request.auth?.userId) {
        return reply.code(401).send({ error: 'login_required' });
      }

      const body = (request.body ?? {}) as { st?: string; decision?: string; target?: any };
      if (!body.st || (body.decision !== 'approve' && body.decision !== 'deny')) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const payload = OAuthStateService.verify(body.st);
      if (!payload) {
        return reply.code(400).send({ error: 'invalid_request', error_description: 'invalid or expired state' });
      }

      if (body.decision === 'deny') {
        const u = new URL(payload.redirect_uri);
        u.searchParams.set('error', 'access_denied');
        u.searchParams.set('state', payload.state);
        return reply.send({ redirect_to: u.toString() });
      }

      const t = body.target ?? {};
      const target = {
        key_scope: t.key_scope === 'app' ? 'app' : 'account',
        target_app_id: typeof t.target_app_id === 'string' ? t.target_app_id : undefined,
        additional_scopes: Array.isArray(t.additional_scopes)
          ? t.additional_scopes.filter((s: unknown) => typeof s === 'string')
          : [],
        read_only: t.read_only === true,
      } as const;

      if (target.key_scope === 'app' && !target.target_app_id) {
        return reply.code(400).send({ error: 'invalid_request', error_description: 'target_app_id required when key_scope is app' });
      }

      const { code } = await OAuthCodeService.issue(app.controlDb, {
        client_id: payload.client_id,
        user_id: request.auth.userId,
        redirect_uri: payload.redirect_uri,
        scope: payload.scope,
        code_challenge: payload.code_challenge,
        requested_target: target,
      });
      await OAuthClientService.touch(app.controlDb, payload.client_id);

      const u = new URL(payload.redirect_uri);
      u.searchParams.set('code', code);
      u.searchParams.set('state', payload.state);
      return reply.send({ redirect_to: u.toString() });
    },
  });
}
