import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';

/**
 * Proxies all /dashboard/* requests to the dashboard-api service (port 4100).
 * The dashboard-api handles its own JWT auth, so these routes bypass control-api auth.
 */
const dashboardProxyPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.all('/dashboard/*', { config: { public: true } }, async (request, reply) => {
    const target = `${config.dashboardApiUrl}${request.url}`;

    const headers: Record<string, string> = {
      'content-type': request.headers['content-type'] ?? 'application/json',
    };
    if (request.headers.authorization) {
      headers['authorization'] = request.headers.authorization;
    }
    // Forward org-context + as-user headers so downstream services (dashboard-api,
    // and eventually control-api's own AppResolver) can honour explicit org
    // scoping. Stripping these here caused team-org members to hit 404 on
    // /dashboard/apps/:id/* routes when browsing an app in an org other than
    // their personal one.
    const orgHeader = request.headers['x-organization-id'];
    if (typeof orgHeader === 'string' && orgHeader) headers['x-organization-id'] = orgHeader;
    const asUser = request.headers['x-butterbase-as-user'];
    if (typeof asUser === 'string' && asUser) headers['x-butterbase-as-user'] = asUser;
    // Forward first-touch signup attribution headers so dashboard-api's auth
    // middleware can persist them on the platform_users INSERT. Without this
    // pass-through the browser's captured utm_* values are dropped at the
    // proxy boundary and every new signup gets signup_source = NULL.
    const signupSource = request.headers['x-signup-source'];
    if (typeof signupSource === 'string' && signupSource) headers['x-signup-source'] = signupSource;
    const signupReferrer = request.headers['x-signup-referrer'];
    if (typeof signupReferrer === 'string' && signupReferrer) headers['x-signup-referrer'] = signupReferrer;

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? JSON.stringify(request.body) : undefined,
    });

    reply.status(upstream.status);

    const ct = upstream.headers.get('content-type');
    if (ct) reply.header('content-type', ct);

    return reply.send(await upstream.text());
  });
};

export default fp(dashboardProxyPlugin, { name: 'dashboard-proxy' });
