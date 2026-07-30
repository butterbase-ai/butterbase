import type { Pool } from 'pg';
import { butterbaseRegionToFlyRegion, parseFlyRegionMap } from '@butterbase/shared';
import { config } from '../../config.js';
import { resolveAppHomeRegion } from '../region-resolver.js';
import { getRuntimeDbPool } from '../runtime-db.js';
import { notifyAuthHookFailed } from '../failure-notifications.service.js';

interface AuthHookPayload {
  event: 'oauth_login' | 'signup' | 'login' | 'magic_link_login';
  user: {
    id: string;
    email: string;
    provider: string;
    display_name?: string | null;
    avatar_url?: string | null;
  };
  isNewUser: boolean;
  provider: string;
}

/**
 * Build the region-affinity header for the hook fetch.
 *
 * `config.runtimeUrl` is a Fly Anycast hostname (butterbase-runtime.fly.dev)
 * that routes to the runtime instance nearest the *calling* control-api — not
 * the app's home region. The deno-runtime's function-loader only queries its
 * own instance-region runtime DB, so a hook for an app homed elsewhere resolves
 * to zero rows and the runtime returns 404 "Function not found". Unlike the
 * per-app data/function routes, the auth routes are not gated by
 * `requiresAppRegion`, so the fly-replay plugin never bounces them to the home
 * region. We compensate here by asking Fly to prefer the home region's runtime,
 * mirroring the mapping the fly-replay plugin uses.
 *
 * Returns `{}` when the region map is unset (local dev / tests) or no fly region
 * maps to the home region — in which case the fetch falls back to Anycast's
 * nearest-instance behaviour, i.e. today's behaviour, so there is no regression.
 */
export function authHookRegionHeaders(homeRegion: string): Record<string, string> {
  const mapRaw = process.env.BUTTERBASE_FLY_REGION_MAP;
  if (!mapRaw) return {};
  try {
    const flyRegion = butterbaseRegionToFlyRegion(homeRegion, parseFlyRegionMap(mapRaw));
    return flyRegion ? { 'Fly-Prefer-Region': flyRegion } : {};
  } catch {
    return {};
  }
}

/**
 * Fire the post_auth hook for an app, if configured.
 * This is fire-and-forget: errors are logged but never propagated.
 */
export function fireAuthHook(
  controlDb: Pool,
  appId: string,
  payload: AuthHookPayload,
  logger: { warn: (obj: any, msg: string) => void },
): void {
  void (async () => {
    try {
      const homeRegion = await resolveAppHomeRegion(controlDb, appId);
      const runtimePool = getRuntimeDbPool(config.runtimeDb, homeRegion);
      const result = await runtimePool.query(
        'SELECT auth_hook_function FROM apps WHERE id = $1',
        [appId],
      );
      const hookFunction = result.rows[0]?.auth_hook_function;
      if (!hookFunction) return;

      try {
        const response = await fetch(`${config.runtimeUrl}/execute/${appId}/${hookFunction}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-app-id': appId,
            // Route to the app's home-region runtime — see authHookRegionHeaders.
            ...authHookRegionHeaders(homeRegion),
          },
          body: JSON.stringify(payload),
        });
        if (response.ok) return;
        const body = await response.text().catch(() => '');
        logger.warn({ appId, hookFunction, status: response.status }, 'Auth hook returned non-2xx');
        notifyAuthHookFailed(controlDb, runtimePool, {
          appId,
          hookFunction,
          event: payload.event,
          errorMessage: `HTTP ${response.status}: ${body.slice(0, 500)}`,
        }, logger);
      } catch (err) {
        logger.warn({ err, appId, hookFunction }, 'Auth hook invocation failed');
        notifyAuthHookFailed(controlDb, runtimePool, {
          appId,
          hookFunction,
          event: payload.event,
          errorMessage: err instanceof Error ? err.message : String(err),
        }, logger);
      }
    } catch (err) {
      logger.warn({ err, appId }, 'Auth hook lookup failed');
    }
  })();
}
