import type { FastifyInstance } from 'fastify';
import { resolveAppHomeRegion } from '../services/region-resolver.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { config } from '../config.js';
import {
  listSourceEnvVarKeys, detectConventions,
  AUTO_MINT_CONVENTION_KEYS, STATIC_FILL_KEYS,
} from '../services/clone-env-vars.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { RESOURCE_NOT_FOUND, AUTH_INSUFFICIENT_PERMISSIONS } from '@butterbase/shared/error-types';

/**
 * GET /v1/templates/:source_app_id/clone-preflight
 *
 * Lists the env vars a caller will need to supply (or accept auto-mint for)
 * before cloning this app. Returns per-function KEY NAMES only (never values).
 *
 * Auth policy: anonymous reads are allowed for PUBLIC apps (env var KEY NAMES
 * are part of a template's public surface area — values never leave the
 * server). Private apps require the caller to be the owner. This is
 * intentionally more permissive than POST /clone, which always requires an
 * authenticated user — discovery should not need credentials. Error shape
 * matches clone.ts via createAgentError so callers can use a single error
 * handler across both.
 */
export function cloneRoutesPreflight(app: FastifyInstance) {
  app.get<{ Params: { source_app_id: string } }>(
    '/v1/templates/:source_app_id/clone-preflight',
    async (request, reply) => {
      const { source_app_id } = request.params;

      let region: string;
      try {
        region = await resolveAppHomeRegion(app.controlDb, source_app_id);
      } catch {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'Source app not found.',
          remediation: 'Verify the app id and that the source app has visibility=public.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
        }));
      }
      const runtimePool = getRuntimeDbPool(config.runtimeDb, region);

      const appRow = await runtimePool.query<{ visibility: string | null; owner_id: string }>(
        `SELECT visibility, owner_id FROM apps WHERE id = $1`,
        [source_app_id],
      );
      if (appRow.rows.length === 0) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'Source app not found.',
          remediation: 'Verify the app id.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
        }));
      }
      const { visibility, owner_id } = appRow.rows[0];
      // Treat NULL visibility as non-public — only an owner sees those.
      const callerIsOwner = request.auth?.userId === owner_id;
      if (visibility !== 'public' && !callerIsOwner) {
        return reply.code(403).send(createAgentError({
          code: AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Only the owner can preflight a non-public app.',
          remediation: 'Ask the source app owner to set visibility=public, or use credentials that match the owner.',
          documentation_url: getDocUrl(AUTH_INSUFFICIENT_PERMISSIONS),
        }));
      }

      try {
        const fns = await listSourceEnvVarKeys(runtimePool, source_app_id, app.log);

        // Does the source have a meetings webhook configured? If so, the
        // platform mints a fresh wsec_* and wires it into the receiver
        // function at clone time, so the cloner never has to provide one.
        let hasMeetingsWebhook = false;
        try {
          const wh = await app.controlDb.query<{ ok: boolean }>(
            `SELECT 1 AS ok FROM app_meetings_webhooks WHERE app_id = $1 LIMIT 1`,
            [source_app_id],
          );
          hasMeetingsWebhook = wh.rows.length > 0;
        } catch (whErr) {
          app.log.warn({ err: whErr, source_app_id }, 'clone-preflight: app_meetings_webhooks probe failed; assuming none');
        }

        const classify = (key: string): { status: 'user_required' | 'auto_filled'; reason?: string } => {
          if (STATIC_FILL_KEYS.includes(key)) {
            return { status: 'auto_filled', reason: 'Platform-resolved at clone time.' };
          }
          if (AUTO_MINT_CONVENTION_KEYS.includes(key)) {
            return { status: 'auto_filled', reason: 'Auto-minted bb_sk_* scoped to the new app.' };
          }
          if (key === 'NOTETAKER_WEBHOOK_SECRET' && hasMeetingsWebhook) {
            return { status: 'auto_filled', reason: 'Auto-minted wsec_* and wired into the receiver function.' };
          }
          return { status: 'user_required' };
        };

        return {
          functions: fns.map(f => ({
            fn_name: f.fn_name,
            keys: f.keys,
            // Legacy field kept for older dashboards.
            conventions: detectConventions(f.keys),
            // New per-key annotation. Dashboards that read this can drop the
            // input entirely for `auto_filled` rows.
            key_meta: f.keys.map(k => ({ key: k, ...classify(k) })),
          })),
        };
      } catch (err) {
        app.log.error({ err, source_app_id }, 'clone-preflight: listSourceEnvVarKeys threw');
        return reply.code(500).send(createAgentError({
          code: 'INTERNAL_ERROR',
          message: 'Failed to read source env var requirements.',
          remediation: 'Retry shortly; if this persists, contact support.',
        }));
      }
    },
  );
}
