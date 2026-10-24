import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { markAppActive } from '../services/app-activity.js';
import { appIdFromParams, isGateSkipped } from './pause-gate.js';

const activityPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode >= 500 || reply.hasHeader('fly-replay')) return;
    if (isGateSkipped((request.raw.url ?? '').split('?')[0])) return;
    const appId = appIdFromParams(request.params) ?? request.subdomainAppId;
    if (appId) await markAppActive(app.controlDb, appId, request.log);
  });
};

export default fp(activityPlugin, { name: 'app-activity' });
