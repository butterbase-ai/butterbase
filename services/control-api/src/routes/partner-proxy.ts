import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveEligibilityForHackathon } from '../services/hackathons/eligibility.js';
import { loadPool, countActiveKeys } from '../services/partner-proxy/pool.js';
import { forwardRequest, type ForwardInput } from '../services/partner-proxy/forwarder.js';
import { createAgentError } from '../services/error-handler.js';
import { config, assertRegionConfig } from '../config.js';

const RESPONSE_HEADER_BLOCKLIST = new Set([
  'transfer-encoding', 'connection', 'content-length',
  // Cookies and partner security headers must not pass through the proxy
  // (we are a different origin from the partner; their CSP/HSTS/Set-Cookie
  // would either leak partner state to the agent or break our own surface).
  'set-cookie', 'strict-transport-security', 'content-security-policy',
]);

function eligibilityErrorReply(
  reply: FastifyReply,
  hackathonSlug: string,
  reason: 'not_found' | 'not_in_window' | 'not_participant' | 'revoked',
) {
  if (reason === 'not_found') {
    return reply.code(404).send(createAgentError({
      code: 'HACKATHON_NOT_FOUND',
      message: `No hackathon with slug "${hackathonSlug}" exists.`,
      remediation: 'Check the slug, or list visible hackathons via the dashboard.',
    }));
  }
  if (reason === 'not_in_window') {
    return reply.code(503).send(createAgentError({
      code: 'HACKATHON_NOT_IN_WINDOW',
      message: `Hackathon "${hackathonSlug}" is not currently accepting partner-API traffic.`,
      remediation: 'Wait for it to open, or use a different hackathon slug.',
    }));
  }
  return reply.code(403).send(createAgentError({
    code: 'NOT_HACKATHON_PARTICIPANT',
    message: `You are not a registered participant of "${hackathonSlug}".`,
    remediation: 'Ask the hackathon host for a participant code, then submit it via the hackathon MCP tool.',
  }));
}

function rejectTraversal(pathPart: string): boolean {
  // Only inspect the path (no query). Reject any segment that is exactly
  // '.' or '..'. We compare case-sensitively per the URL spec — encoded
  // forms (%2e%2e) are left to the partner to reject.
  for (const seg of pathPart.split('/')) {
    if (seg === '..' || seg === '.') return true;
  }
  return false;
}

export async function partnerProxyRoutes(fastify: FastifyInstance) {
  const region = assertRegionConfig().instanceRegion;

  // The proxy forwards request bodies verbatim. Fastify's default JSON parser
  // would turn application/json into a JS object, and undici's fetch then
  // coerces that object via String() to "[object Object]" — which the partner
  // receives and rejects. Override the JSON parser inside this plugin scope
  // to keep the body as a raw Buffer. The wildcard parser in index.ts already
  // handles every other content type as Buffer.
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { appId, hackathonSlug, slug } = request.params as {
      appId: string; hackathonSlug: string; slug: string; '*'?: string;
    };
    const wildcard = (request.params as { '*'?: string })['*'] ?? '';

    const userId = request.auth?.userId;
    if (!userId) {
      return reply.code(401).send(createAgentError({
        code: 'AUTH_REQUIRED',
        message: 'Authentication required.',
        remediation: 'Provide a Butterbase API key (bb_sk_*) or user JWT.',
      }));
    }

    const elig = await resolveEligibilityForHackathon(fastify.controlDb, userId, hackathonSlug);
    if (!elig.eligible) {
      return eligibilityErrorReply(reply, hackathonSlug, elig.reason);
    }

    const pool = await loadPool(fastify.runtimeDb(region), elig.hackathon.id, slug);
    if (!pool) {
      return reply.code(404).send(createAgentError({
        code: 'PARTNER_NOT_FOUND',
        message: `No partner with slug "${slug}" is configured for hackathon "${hackathonSlug}".`,
        remediation: 'List configured partners with the list_partner_apis MCP tool.',
      }));
    }

    const qIndex = (request.raw.url ?? '').indexOf('?');
    const querystring = qIndex >= 0 ? (request.raw.url ?? '').slice(qIndex) : '';
    const pathAndQuery = `/${wildcard}${querystring}`;

    if (rejectTraversal(`/${wildcard}`)) {
      return reply.code(400).send(createAgentError({
        code: 'INVALID_PATH',
        message: 'Partner proxy paths must not contain "." or ".." segments.',
        remediation: 'Remove relative-path segments and call a concrete partner endpoint.',
      }));
    }

    const input: ForwardInput = {
      method: request.method,
      pathAndQuery,
      headers: request.headers as Record<string, string | string[] | undefined>,
      body: request.body as Buffer | undefined,
    };

    const start = Date.now();
    const result = await forwardRequest(fastify.runtimeDb(region), pool, input);
    const latencyMs = Date.now() - start;

    if (result.kind === 'exhausted') {
      void fastify.runtimeDb(region).query(
        `INSERT INTO partner_proxy_logs (pool_id, app_id, user_id, method, path, status_code, latency_ms, failover_attempts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [pool.id, appId, userId, request.method, pathAndQuery, 503, latencyMs, result.attempts],
      ).catch((err) => fastify.log.warn({ err }, 'partner_proxy_logs insert failed'));

      const errBody = createAgentError({
        code: 'PARTNER_QUOTA_EXHAUSTED',
        message: `The free ${pool.display_name} quota for this hackathon has been used up.`,
        remediation: pool.contact_message,
        details: { partner: pool.slug },
      });
      (errBody.error as Record<string, unknown>).partner = pool.slug;
      return reply.code(503).send(errBody);
    }

    const partnerRes = result.response;
    const bodyText = await partnerRes.arrayBuffer();
    const bytesOut = bodyText.byteLength;

    reply.code(partnerRes.status);
    partnerRes.headers.forEach((value, key) => {
      if (!RESPONSE_HEADER_BLOCKLIST.has(key.toLowerCase())) {
        reply.header(key, value);
      }
    });

    void fastify.runtimeDb(region).query(
      `INSERT INTO partner_proxy_logs (pool_id, key_id, app_id, user_id, method, path, status_code, bytes_in, bytes_out, latency_ms, failover_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [pool.id, result.keyId, appId, userId, request.method, pathAndQuery,
       partnerRes.status, Buffer.isBuffer(input.body) ? input.body.length : null,
       bytesOut, latencyMs, result.attempts],
    ).catch((err) => fastify.log.warn({ err }, 'partner_proxy_logs insert failed'));

    return reply.send(Buffer.from(bodyText));
  };

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    fastify.route({ method, url: '/v1/:appId/partners/:hackathonSlug/:slug/*', handler });
  }

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    fastify.route({
      method,
      url: '/v1/:appId/partners/:hackathonSlug/:slug',
      handler: async (request, reply) => {
        (request.params as Record<string, unknown>)['*'] = '';
        return handler(request, reply);
      },
    });
  }

  fastify.get<{ Params: { appId: string; hackathonSlug: string } }>(
    '/v1/:appId/partners/:hackathonSlug',
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) {
        return reply.code(401).send(createAgentError({
          code: 'AUTH_REQUIRED', message: 'Authentication required.',
          remediation: 'Provide a Butterbase API key.',
        }));
      }
      const elig = await resolveEligibilityForHackathon(
        fastify.controlDb, userId, request.params.hackathonSlug,
      );
      if (!elig.eligible) {
        return eligibilityErrorReply(reply, request.params.hackathonSlug, elig.reason);
      }
      const { rows } = await fastify.runtimeDb(region).query(
        `SELECT id, slug, display_name, base_url, contact_message, docs_url, description
         FROM partner_pools WHERE hackathon_id = $1 ORDER BY slug`,
        [elig.hackathon.id],
      );
      const partners = await Promise.all(rows.map(async (r) => ({
        slug: r.slug,
        display_name: r.display_name,
        description: r.description,
        docs_url: r.docs_url,
        proxy_url_template:
          `${config.apiBaseUrl}/v1/${request.params.appId}/partners/${request.params.hackathonSlug}/${r.slug}{path}`,
        contact_message: r.contact_message,
        status: (await countActiveKeys(fastify.runtimeDb(region), r.id)) > 0 ? 'available' : 'exhausted',
      })));
      return { partners };
    },
  );
}
