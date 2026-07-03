import type { FastifyInstance } from 'fastify';
import { OAuthClientService } from '../services/oauth-client-service.js';
import { OAuthStateService } from '../services/oauth-state-service.js';
import { OAuthCodeService } from '../services/oauth-code-service.js';
import { ApiKeyService } from '../services/api-key-service.js';
import { config } from '../config.js';

const ALLOWED_SCOPES = new Set(['mcp', 'ai:gateway']);

// In-memory token bucket per IP for /oauth/register. Phase-1 mitigation against
// trivial filling of oauth_clients. Follow-up: replace with a Redis counter so
// the limit holds across control-api replicas.
const REGISTER_LIMIT_PER_HOUR = 10;
const registerBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimitRegister(ip: string): boolean {
  const now = Date.now();
  const bucket = registerBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    registerBuckets.set(ip, { count: 1, resetAt: now + 3_600_000 });
    return true;
  }
  if (bucket.count >= REGISTER_LIMIT_PER_HOUR) return false;
  bucket.count++;
  return true;
}

// CSRF gate for the consent endpoints. They are reached from the dashboard
// (cookie/JWT auth) and mutate state (decide mints a code; details leaks the
// user's app list). Origin must equal the dashboard URL. E2E tests bypass.
function enforceDashboardOrigin(
  request: { headers: Record<string, string | string[] | undefined> },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
): boolean {
  if (process.env.BUTTERBASE_E2E === '1') return true;
  const allowed = config.dashboardUrl;
  if (!allowed) return true;
  const originRaw = request.headers.origin;
  const origin = Array.isArray(originRaw) ? originRaw[0] : originRaw;
  if (origin !== allowed) {
    reply.code(403).send({ error: 'invalid_origin', error_description: 'Origin not allowed' });
    return false;
  }
  return true;
}

export async function oauthRoutes(app: FastifyInstance) {
  app.route({
    method: 'POST',
    url: '/oauth/register',
    config: { public: true },
    handler: async (request, reply) => {
      // E2E test harness exercises this endpoint dozens of times per run from
      // 127.0.0.1; skipping under the explicit flag keeps the limit honest in
      // prod without breaking deterministic test setup.
      if (process.env.BUTTERBASE_E2E !== '1') {
        const ip = request.ip ?? 'unknown';
        if (!rateLimitRegister(ip)) {
          return reply.code(429).send({ error: 'too_many_requests', error_description: 'Rate limit exceeded; try again in an hour.' });
        }
      }
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
      if (!enforceDashboardOrigin(request, reply)) return reply;
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

      // The authoritative `apps` row lives in the regional runtime DB after
      // migration 061. `user_app_index` is the control-plane projection used
      // for cross-region "list my apps" — exactly what the consent screen
      // needs. Eventually consistent but fine for picking a target app.
      const apps = await app.controlDb.query<{ id: string; name: string }>(
        `SELECT app_id AS id, COALESCE(app_name, app_id) AS name
           FROM user_app_index
          WHERE user_id = $1
          ORDER BY created_at DESC`,
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
      if (!enforceDashboardOrigin(request, reply)) return reply;
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
      // NOTE: read_only is intentionally dropped here. The consent UI still
      // accepts it and labels it "(coming soon)". Enforcement requires a
      // future migration to add `api_keys.read_only` + a guard in
      // ApiKeyService — until then we don't persist the flag rather than
      // silently lie about it.
      const target = {
        key_scope: t.key_scope === 'app' ? 'app' : 'account',
        target_app_id: typeof t.target_app_id === 'string' ? t.target_app_id : undefined,
        additional_scopes: Array.isArray(t.additional_scopes)
          ? t.additional_scopes.filter((s: unknown) => typeof s === 'string')
          : [],
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

  app.route({
    method: 'POST',
    url: '/oauth/token',
    config: { public: true },
    handler: async (request, reply) => {
      // Accept either JSON (Fastify built-in parser) or
      // application/x-www-form-urlencoded (registered parser → object;
      // wildcard fallback → Buffer/string).
      let body: Record<string, string> = {};
      if (typeof request.body === 'string') {
        body = Object.fromEntries(new URLSearchParams(request.body));
      } else if (Buffer.isBuffer(request.body)) {
        body = Object.fromEntries(new URLSearchParams(request.body.toString('utf8')));
      } else if (request.body && typeof request.body === 'object') {
        body = request.body as Record<string, string>;
      }

      if (body.grant_type !== 'authorization_code') {
        return reply.code(400).send({ error: 'unsupported_grant_type' });
      }
      if (!body.code || !body.client_id || !body.redirect_uri || !body.code_verifier) {
        return reply.code(400).send({
          error: 'invalid_request',
          error_description: 'code, client_id, redirect_uri, code_verifier required',
        });
      }

      const consumed = await OAuthCodeService.consume(app.controlDb, {
        code: body.code,
        client_id: body.client_id,
        redirect_uri: body.redirect_uri,
        code_verifier: body.code_verifier,
      });
      if ('error' in consumed) {
        return reply.code(400).send({ error: consumed.error });
      }

      const t = consumed.requested_target;
      const client = await OAuthClientService.lookup(app.controlDb, body.client_id);
      const displayName = `OAuth: ${client?.client_name ?? body.client_id}`;
      // Detect substrate scope in the granted OAuth scopes → mint with
      // substrateAccess='both' so bb_sk_* also carries substrate_organization_id.
      const grantedScopes = (consumed.scope ?? '').split(/\s+/).filter(Boolean);
      const wantsSubstrate = grantedScopes.includes('mcp');
      const minted = await ApiKeyService.generateApiKey(
        app.controlDb,
        consumed.user_id,
        displayName,
        {
          keyScope: t.key_scope,
          targetAppId: t.target_app_id,
          additionalScopes: t.additional_scopes ?? [],
          substrateAccess: wantsSubstrate ? 'both' : 'app',
        }
      );

      // Tokens minted via OAuth never expire — users revoke via the API Keys
      // dashboard when they're done. Per RFC 6749 §5.1, expires_in is OPTIONAL;
      // omitting it tells the client the token has no fixed lifetime.
      return reply.send({
        access_token: minted.key,
        token_type: 'Bearer',
        scope: consumed.scope,
      });
    },
  });
}
