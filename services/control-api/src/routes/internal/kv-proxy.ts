import type { FastifyPluginAsync } from 'fastify';
import { KvCredentialsService } from '../../services/kv-credentials.js';

function gatewayUrlForRegion(region: string): string {
  const upper = region.toUpperCase().replace(/-/g, '_');
  return (
    process.env[`KV_GATEWAY_URL_${upper}`] ??
    process.env.KV_GATEWAY_URL ??
    ''
  );
}

const kvProxyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: ['GET', 'PUT', 'POST', 'DELETE', 'PATCH'],
    url: '/v1/internal/kv/proxy/:app_id/*',
    handler: async (request, reply) => {
      // Authenticate via bearer dev API key
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
        return reply.code(401).send({ error: 'missing_bearer' });
      }
      const apiKey = authHeader.slice(7).trim();

      const { app_id: appId } = request.params as { app_id: string };
      const wildcard = (request.params as Record<string, string>)['*'] ?? '';

      // Validate that this key owns the requested app and get its region
      const svc = new KvCredentialsService(fastify.controlDb);
      const cred = await svc.resolveDevApiKeyForApp(apiKey, appId);
      if (!cred) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      // Resolve gateway URL for the app's region
      const base = gatewayUrlForRegion(cred.region);
      if (!base) {
        request.log.error({ region: cred.region }, 'no_gateway_url_for_region');
        return reply.code(500).send({ error: 'no_gateway_for_region' });
      }

      // Build upstream URL: <gateway>/v1/<app_id>/kv/<wildcard>?<qs>
      const qs = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      const upstream = `${base.replace(/\/$/, '')}/v1/${appId}/kv/${wildcard}${qs}`;

      // Forward original headers
      const headers = new Headers();
      headers.set('authorization', authHeader);
      const ct = request.headers['content-type'];
      if (ct) headers.set('content-type', String(ct));

      const init: RequestInit = {
        method: request.method,
        headers,
      };

      // Attach body for non-idempotent methods
      if (request.method !== 'GET' && request.method !== 'DELETE') {
        const body = request.body;
        if (body !== undefined && body !== null) {
          if (Buffer.isBuffer(body)) {
            init.body = body;
          } else if (typeof body === 'string') {
            init.body = body;
          } else {
            init.body = JSON.stringify(body);
          }
        }
      }

      let upstreamRes: Response;
      let buf: ArrayBuffer;
      try {
        upstreamRes = await fetch(upstream, init);
        buf = await upstreamRes.arrayBuffer();
      } catch (e) {
        request.log.error({ err: e, upstream }, 'kv_proxy_upstream_fetch_failed');
        return reply.code(502).send({ error: 'upstream_unreachable' });
      }

      reply.code(upstreamRes.status);
      const upstreamCt = upstreamRes.headers.get('content-type');
      if (upstreamCt) reply.header('content-type', upstreamCt);
      return reply.send(Buffer.from(buf));
    },
  });
};

export default kvProxyRoutes;
