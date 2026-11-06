import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { markAppActive } from '../services/app-activity.js';
import { appIdFromParams, isGateSkipped } from './pause-gate.js';
import { CRON_ORIGIN_HEADER, verifyCronOrigin, withVerifiedCronOrigin } from '../services/cron-origin.js';

const activityPlugin: FastifyPluginAsync = async (app) => {
  const admitted = new WeakMap<FastifyRequest, { appId: string; token: string }>();
  const rememberOrigin = (request: FastifyRequest) => {
    const appId = appIdFromParams(request.params) ?? request.subdomainAppId ?? '';
    const token = request.headers[CRON_ORIGIN_HEADER];
    if (verifyCronOrigin(token, appId)) admitted.set(request, { appId, token });
  };
  app.addHook('onRequest', (request, _reply, done) => { rememberOrigin(request); done(); });
  // Callback-style hook deliberately runs the downstream chain inside its own
  // async context. enterWith() would allow concurrent requests to share origin.
  app.addHook('preHandler', (request, _reply, done) => {
    const appId = appIdFromParams(request.params) ?? request.subdomainAppId ?? '';
    rememberOrigin(request); // Subdomain resolution happens in a later onRequest hook.
    const origin = admitted.get(request);
    withVerifiedCronOrigin(appId, origin?.appId === appId ? origin.token : undefined, done);
  });
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode >= 500 || reply.hasHeader('fly-replay')) return;
    if (isGateSkipped((request.raw.url ?? '').split('?')[0])) return;
    const appId = appIdFromParams(request.params) ?? request.subdomainAppId;
    if (appId && admitted.get(request)?.appId !== appId && !verifyCronOrigin(request.headers[CRON_ORIGIN_HEADER], appId)) {
      await markAppActive(app.controlDb, appId, request.log);
    }
  });
};

export default fp(activityPlugin, { name: 'app-activity' });
