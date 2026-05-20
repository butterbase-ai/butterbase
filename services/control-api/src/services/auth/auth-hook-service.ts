import type { Pool } from 'pg';
import { config } from '../../config.js';
import { getRuntimeDbForApp } from '../region-resolver.js';
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
      const runtimePool = await getRuntimeDbForApp(controlDb, appId);
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
