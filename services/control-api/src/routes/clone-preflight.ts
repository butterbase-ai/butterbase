import type { FastifyInstance } from 'fastify';
import { resolveAppHomeRegion } from '../services/region-resolver.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { config } from '../config.js';
import {
  listSourceEnvVarKeys, detectConventions,
  AUTO_MINT_CONVENTION_KEYS, STATIC_FILL_KEYS,
} from '../services/clone-env-vars.js';
import { listDoEnvVarKeys } from '../services/durable-objects.service.js';
import { decrypt } from '../services/crypto.js';
import type { Pool } from 'pg';
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
async function loadAppEnvKeys(db: Pool, appId: string): Promise<string[]> {
  const r = await db.query<{ encrypted_env_vars: string }>(
    `SELECT encrypted_env_vars FROM app_env_vars WHERE app_id = $1`, [appId],
  );
  if (r.rows.length === 0) return [];
  const encKey = process.env.AUTH_ENCRYPTION_KEY!;
  try {
    return Object.keys(JSON.parse(decrypt(r.rows[0].encrypted_env_vars, encKey)));
  } catch {
    return [];
  }
}

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

        // Durable Object env vars are surfaced under a separate key so
        // callers can see they must be re-set post-clone via
        // manage_durable_objects action=set_env (the platform never copies
        // DO env values across apps — they're app-scoped secrets).
        let doEnvKeys: string[] = [];
        try {
          doEnvKeys = await listDoEnvVarKeys(runtimePool, source_app_id);
        } catch (doErr) {
          app.log.warn({ err: doErr, source_app_id }, 'clone-preflight: listDoEnvVarKeys failed; assuming none');
        }

        let appEnvKeys: string[] = [];
        try {
          appEnvKeys = await loadAppEnvKeys(runtimePool, source_app_id);
        } catch (aeErr) {
          app.log.warn({ err: aeErr, source_app_id }, 'clone-preflight: loadAppEnvKeys failed; assuming none');
        }

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
          durable_objects: {
            env_keys: doEnvKeys,
            // Same per-key annotation shape as functions: convention keys are
            // auto-minted with the shared clone bb_sk_*; anything else remains
            // a secret the caller must re-set via manage_durable_objects
            // action=set_env after clone.
            key_meta: doEnvKeys.map((k) =>
              AUTO_MINT_CONVENTION_KEYS.includes(k)
                ? { key: k, status: 'auto_filled' as const, reason: 'Auto-minted bb_sk_* scoped to the new app (shared with functions).' }
                : { key: k, status: 'user_required' as const },
            ),
            note: doEnvKeys.some((k) => !AUTO_MINT_CONVENTION_KEYS.includes(k))
              ? 'Non-convention DO env values are not carried across clones. Re-set each user_required key via manage_durable_objects action=set_env once the clone completes.'
              : undefined,
          },
          app_env: {
            keys: appEnvKeys,
            note: 'These app-level env vars are copied to the clone. Override any of them with PATCH /v1/:appId/env after clone.',
          },
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
