import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { config } from '../config.js';

// Extend FastifyRequest
declare module 'fastify' {
  interface FastifyRequest {
    /** App ID resolved from subdomain (e.g. myapp.butterbase.dev → app_id) */
    subdomainAppId?: string;
    /** Raw subdomain extracted from Host header */
    subdomain?: string;
  }
}

// LRU cache: subdomain → app_id
const subdomainCache = new Map<string, { appId: string; expires: number }>();
const CACHE_TTL = 30_000; // 30 seconds

const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function extractSubdomain(host: string | undefined): string | null {
  if (!host) return null;

  // Strip port
  const hostname = host.split(':')[0];
  const baseDomain = config.subdomain.baseDomain;

  if (!hostname.endsWith(`.${baseDomain}`)) return null;

  const subdomain = hostname.slice(0, -(baseDomain.length + 1));

  // Validate: single label, DNS-safe
  if (!subdomain || subdomain.includes('.') || subdomain.length > 63) return null;
  if (!SUBDOMAIN_REGEX.test(subdomain)) return null;

  return subdomain;
}

const subdomainPlugin: FastifyPluginAsync = async (fastify) => {
  if (!config.subdomain.enabled) return;

  fastify.decorateRequest('subdomainAppId', undefined);
  fastify.decorateRequest('subdomain', undefined);

  fastify.addHook('onRequest', async (request) => {
    const subdomain = extractSubdomain(request.headers.host);
    if (!subdomain) return;

    request.subdomain = subdomain;

    // Check cache
    const cached = subdomainCache.get(subdomain);
    if (cached && cached.expires > Date.now()) {
      request.subdomainAppId = cached.appId;
      return;
    }

    // DB lookup — org_app_index is the cross-region authoritative map of
    // subdomain → app, so we don't need to know the home region first.
    const result = await fastify.controlDb.query(
      `SELECT app_id FROM org_app_index WHERE subdomain = $1`,
      [subdomain]
    );

    if (result.rows.length > 0) {
      const appId = result.rows[0].app_id;
      subdomainCache.set(subdomain, { appId, expires: Date.now() + CACHE_TTL });
      request.subdomainAppId = appId;
    }
  });
};

export default fp(subdomainPlugin, {
  name: 'subdomain',
  dependencies: ['database'],
});

export { extractSubdomain };
