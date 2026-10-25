import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { markAppActive } from '../services/app-activity.js';
import { appIdFromParams, isGateSkipped } from './pause-gate.js';
import { CRON_ORIGIN_HEADER, verifyCronOrigin, withCronOrigin } from '../services/cron-origin.js';

const activityPlugin: FastifyPluginAsync = async (app) => {
  // Callback-style hook deliberately runs the downstream chain inside its own
  // async context. enterWith() would allow concurrent requests to share origin.
  app.addHook('preHandler', (request, _reply, done) => {
    const appId = appIdFromParams(request.params) ?? request.subdomainAppId ?? '';
    withCronOrigin(appId, request.headers[CRON_ORIGIN_HEADER], done);
  });
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode >= 500 || reply.hasHeader('fly-replay')) return;
    if (isGateSkipped((request.raw.url ?? '').split('?')[0])) return;
    const appId = appIdFromParams(request.params) ?? request.subdomainAppId;
    if (appId && !verifyCronOrigin(request.headers[CRON_ORIGIN_HEADER], appId)) {
      await markAppActive(app.controlDb, appId, request.log);
    }
  });
};

export default fp(activityPlugin, { name: 'app-activity' });
