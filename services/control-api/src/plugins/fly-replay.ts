import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import type { Redis } from 'ioredis';
import { butterbaseRegionToFlyRegion, parseFlyRegionMap } from '@butterbase/shared';
import { resolveAppRegion, resolveLocalRegion } from '../services/region-resolver.js';
import { createAgentError } from '../services/error-handler.js';
import { getRedisClient } from '../services/redis.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    requiresAppRegion?: boolean;
  }
  interface FastifyInstance {
    redis: Pick<Redis, 'get' | 'setex' | 'del'>;
  }
}

const flyReplayPlugin: FastifyPluginAsync = async (fastify) => {
  // Decorate fastify.redis if not already (test injects its own decoration first).
  if (!fastify.hasDecorator('redis')) {
    fastify.decorate('redis', getRedisClient());
  }

  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.routeOptions.config?.requiresAppRegion) return;

    const params = (request.params as { appId?: string; app_id?: string } | undefined);
    const appId = params?.appId ?? params?.app_id;
    if (!appId) return;

    // Fallback-failed requests come back here from Fly proxy carrying the
    // `fly-replay-failed` header. Per Fly docs, these requests cannot
    // themselves issue another fly-replay — process locally regardless of
    // the app's region (the route handler will use the per-app data-DB
    // connection string for cross-region work).
    if (request.headers['fly-replay-failed']) {
      fastify.log.warn(
        { appId, detail: request.headers['fly-replay-failed'] },
        'fly-replay: fallback engaged — processing cross-region',
      );
      return;
    }

    const localRegion = resolveLocalRegion();
    // resolveAppRegion now queries user_app_index on the control/platform DB
    // (cross-region authoritative map). Pass app.controlDb instead of the
    // per-region runtime pool — the runtime apps table doesn't have rows for
    // apps homed in other regions, so the old lookup 404'd cross-region.
    const region = await resolveAppRegion(fastify.controlDb, fastify.redis, appId);
    if (region === null) {
      return reply.code(404).send(createAgentError({
        code: 'RESOURCE_NOT_FOUND',
        message: `App ${appId} not found`,
        remediation: 'Verify the app id (use list_apps via MCP or `butterbase apps list`). Confirm the caller owns the app.',
      }));
    }
    if (region !== localRegion) {
      // Fly-Replay expects a Fly region code (sjc, sea, lax, iad, …), not the
      // butterbase AWS-style region. Translate via BUTTERBASE_FLY_REGION_MAP.
      // When BUTTERBASE_FLY_REGION_MAP isn't set (local dev / tests), fall
      // back to sending the butterbase region — harmless because Fly proxy
      // only acts on the header in production.
      const mapRaw = process.env.BUTTERBASE_FLY_REGION_MAP;
      let flyRegion: string | null = null;
      if (mapRaw) {
        try {
          flyRegion = butterbaseRegionToFlyRegion(region, parseFlyRegionMap(mapRaw));
        } catch (err) {
          fastify.log.warn({ err, region }, 'fly-replay: failed to parse BUTTERBASE_FLY_REGION_MAP');
        }
      }
      if (!flyRegion) {
        fastify.log.warn(
          { region, mapRaw: mapRaw ? '<set>' : '<unset>' },
          'fly-replay: no fly region for butterbase region; using raw region (will fail in prod)',
        );
        flyRegion = region;
      }
      // fallback=prefer_self: if Fly proxy can't deliver to the target region
      // within `timeout` (machine boot failure, autostart issues, etc.), retry
      // on this machine. The route handler then services the request itself
      // via the per-app data-DB connection string — slower cross-region, but
      // functional. Aligns with Fly's recommended multi-region blueprint.
      reply.header('Fly-Replay', `region=${flyRegion};fallback=prefer_self;timeout=3s`);
      reply.code(204);
      return reply.send();
    }
  });
};

export default fp(flyReplayPlugin, { name: 'fly-replay' });
