// services/control-api/src/plugins/pause-gate.ts
//
// The central pause gate: one root preHandler that makes a paused app
// (apps.paused = true) answer 503 APP_PAUSED on every app-scoped route,
// except an authenticated owner's management calls on non-public routes.
// Paused state is read from the app's home-region runtime DB and cached in
// the local Redis for 30s; every pause/resume busts the key in every region.
//
// Fails open: if the lookup itself errors, the request continues and the
// error is logged. A paused app briefly serving is better than every app
// 500ing when Redis or a runtime DB blips.
//
// Spec: docs/superpowers/specs/2026-10-10-idle-free-app-pause-design.md §5.2

import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import { AppResolver, AppPausedError, AppNotFoundError, type PausedBy } from '../services/app-resolver.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { getRedisClient } from '../services/redis.js';
import { redisFor } from '../services/redis-registry.js';
import { listRuntimeRegions } from '../services/runtime-pool-registry.js';
import { onPauseStateChanged } from '../services/app-pause.js';

const TTL_SECONDS = 30;
// A request racing a resume can re-cache a stale paused=true for up to TTL_SECONDS.
const cacheKey = (appId: string) => `app-paused:${appId}`;

// /v1/templates/: discovery, releases and the :source_app_id clone routes —
// a paused template stays listable and cloneable.
const SKIP_PREFIXES = [
  '/v1/internal/', '/internal/', '/admin/', '/health', '/oauth/',
  '/.well-known/', '/dashboard/', '/webhooks/', '/v1/templates/',
];

export interface CachedPausedState {
  paused: boolean;
  reason: string | null;
  by: PausedBy | null;
}

export function isGateSkipped(path: string): boolean {
  return SKIP_PREFIXES.some((p) => path.startsWith(p));
}

export function appIdFromParams(params: unknown): string | null {
  const p = params as { appId?: string; app_id?: string } | undefined;
  return p?.appId ?? p?.app_id ?? null;
}

/** Paused state of an app, or null when the app doesn't exist. */
export async function readPausedState(controlDb: Pool, appId: string): Promise<CachedPausedState | null> {
  const redis = getRedisClient();
  // A Redis failure is a cache miss, never an error: only DB errors propagate.
  let hit: string | null = null;
  try {
    hit = await redis.get(cacheKey(appId));
  } catch (err) {
    console.warn(`[pause-gate] redis get failed for ${appId}; treating as cache miss: ${(err as Error).message}`);
  }
  if (hit !== null) return JSON.parse(hit) as CachedPausedState;

  let runtimeDb;
  try {
    runtimeDb = await getRuntimeDbForApp(controlDb, appId);
  } catch (err) {
    if (err instanceof AppNotFoundError) return null;
    throw err;
  }
  const r = await runtimeDb.query<{ paused: boolean; paused_reason: string | null; paused_by: PausedBy | null }>(
    'SELECT paused, paused_reason, paused_by FROM apps WHERE id = $1',
    [appId],
  );
  if (r.rows.length === 0) return null;
  const state: CachedPausedState = {
    paused: r.rows[0].paused === true,
    reason: r.rows[0].paused_reason ?? null,
    by: r.rows[0].paused_by ?? null,
  };
  try {
    await redis.setex(cacheKey(appId), TTL_SECONDS, JSON.stringify(state));
  } catch (err) {
    console.warn(`[pause-gate] redis setex failed for ${appId}; returning uncached state: ${(err as Error).message}`);
  }
  return state;
}

/** Throws AppPausedError when the app is paused. Unknown apps pass. */
export async function assertAppIdNotPaused(controlDb: Pool, appId: string): Promise<void> {
  const state = await readPausedState(controlDb, appId);
  if (state?.paused) throw new AppPausedError(appId, state.reason, state.by);
}

export async function invalidatePausedState(appId: string): Promise<void> {
  await Promise.all(
    listRuntimeRegions().map((region) => redisFor(region).del(cacheKey(appId)).catch((err) => {
      console.warn(`[pause-gate] failed to invalidate paused state for ${appId} in ${region}: ${(err as Error).message}`);
      return 0;
    })),
  );
}

const pauseGatePlugin: FastifyPluginAsync = async (fastify) => {
  onPauseStateChanged(({ appId }) => invalidatePausedState(appId));

  fastify.addHook('preHandler', async (request) => {
    const path = (request.raw.url ?? '').split('?')[0];
    if (isGateSkipped(path)) return;
    const appId = appIdFromParams(request.params);
    if (!appId) return;

    let state: CachedPausedState | null;
    try {
      state = await readPausedState(fastify.controlDb, appId);
    } catch (err) {
      request.log.error({ err, appId }, '[pause-gate] paused-state lookup failed; failing open');
      return;
    }
    if (!state?.paused) return;

    const auth = request.auth;
    const ownerCapable = !request.routeOptions.config?.public
      && auth?.userId
      && (auth.authMethod === 'jwt' || auth.authMethod === 'api_key');
    if (ownerCapable) {
      try {
        await AppResolver.resolveApp(fastify.controlDb, appId, auth.userId!, auth.organizationId ?? null);
        return;
      } catch {
        // not the owner (or lookup failed): treat as everyone else
      }
    }
    throw new AppPausedError(appId, state.reason, state.by);
  });
};

export default fp(pauseGatePlugin, { name: 'pause-gate' });
