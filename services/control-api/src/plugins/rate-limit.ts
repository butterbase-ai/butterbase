import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { getRedisClient } from '../services/redis.js';
import { getLimitsForApp } from '../services/app-plan-resolver.js';

const DEFAULT_MAX = 100;
const UNLIMITED_SENTINEL = 1_000_000;

function extractAppId(req: FastifyRequest): string | undefined {
  const params = req.params as { app_id?: string; appId?: string } | undefined;
  return params?.app_id ?? params?.appId;
}

const rateLimitPlugin: FastifyPluginAsync = async (fastify) => {
  // Register the per-route config hook FIRST so it runs before @fastify/rate-limit's
  // own onRoute hook reads per-route config during route registration.
  fastify.addHook('onRoute', (routeOptions) => {
    const url = routeOptions.url ?? '';
    if (!url.startsWith('/v1/:app_id') && !url.startsWith('/v1/:appId')) return;

    // If the route already declares its own per-route rateLimit config, honour it
    // and skip the global app-plan-based override. This allows specific endpoints
    // (e.g. /repo/snapshots/prepare) to define tighter per-route limits without
    // being overridden by the plan-based limit.
    if ((routeOptions.config as { rateLimit?: unknown } | undefined)?.rateLimit) return;

    routeOptions.config = {
      ...(routeOptions.config ?? {}),
      rateLimit: {
        max: async (req: FastifyRequest) => {
          const appId = extractAppId(req);
          if (!appId) return DEFAULT_MAX;
          try {
            const limits = await getLimitsForApp(fastify.controlDb, appId);
            return limits.maxRequestsPerMin === -1
              ? UNLIMITED_SENTINEL
              : limits.maxRequestsPerMin;
          } catch {
            return DEFAULT_MAX;
          }
        },
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => {
          const appId = extractAppId(req);
          return `app:${appId ?? req.ip}`;
        },
      },
    };
  });

  await fastify.register(rateLimit, {
    global: false,
    max: DEFAULT_MAX,
    timeWindow: '1 minute',
    redis: getRedisClient(),
    keyGenerator: (req: FastifyRequest) => {
      const appId = extractAppId(req);
      return appId ? `app:${appId}` : `ip:${req.ip}`;
    },
  });
};

export default fp(rateLimitPlugin, {
  name: 'rate-limit',
});
