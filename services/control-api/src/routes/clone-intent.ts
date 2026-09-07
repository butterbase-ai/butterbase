// POST /v1/templates/:source_app_id/clone-intent
//
// Anonymous counterpart to POST /v1/templates/:source_app_id/clone. A visitor
// browsing the public templates site configures a clone before they have an
// account. This route parks that configuration server-side (encrypted) and
// hands back an opaque intent id; a later task adds the redeem handler that
// turns a parked intent into a real clone job once the visitor registers.
//
// Deliberately does NOT call requireUserId — there is no Authorization header
// to require. Env var VALUES are secrets and must never appear in the
// response, an error message, or a log line; they are handed to
// createCloneIntent, which encrypts them before they touch the database.

import type { FastifyInstance } from 'fastify';
import { rateLimitAllowList } from '../plugins/rate-limit.js';
import { config } from '../config.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { resolveAppHomeRegion } from '../services/region-resolver.js';
import { createCloneIntent } from '../services/clone-intents.js';
import { validateEnvVarValues } from '../services/clone-validation.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { AppNotFoundError } from '../services/app-resolver.js';
import {
  VALIDATION_INVALID_SCHEMA,
  RESOURCE_NOT_FOUND,
} from '@butterbase/shared/error-types';

function sourceNotFound(reply: any) {
  // Deliberately identical whether the app doesn't exist or simply isn't
  // public — the response must not leak which is true.
  return reply.code(404).send(createAgentError({
    code: RESOURCE_NOT_FOUND,
    message: 'Source app not found.',
    remediation: 'Verify the app id and that the source app has visibility=public.',
    documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
  }));
}

export function cloneIntentRoutes(app: FastifyInstance): void {
  app.post('/v1/templates/:source_app_id/clone-intent', {
    config: {
      rateLimit: {
        allowList: rateLimitAllowList,
        max: 10,
        timeWindow: '1 hour',
        keyGenerator: (req) => `ip:${req.ip}:clone-intent`,
      },
    },
  }, async (request, reply) => {
    const { source_app_id } = request.params as { source_app_id: string };
    const body = (request.body ?? {}) as {
      name?: string;
      dest_region?: string;
      env_var_values?: Record<string, Record<string, string>>;
      auto_mint_api_key?: { fn_name: string; key: string }[];
    };

    // 1. Resolve the source app's home region. Translate AppNotFoundError to
    // the same non-leaking 404 used for a non-public app below.
    let sourceRegion: string;
    try {
      sourceRegion = await resolveAppHomeRegion(app.controlDb, source_app_id);
    } catch (err) {
      if (err instanceof AppNotFoundError) return sourceNotFound(reply);
      throw err;
    }

    // 2. Load visibility + snapshot from the region's runtime pool.
    const runtimePool = getRuntimeDbPool(config.runtimeDb, sourceRegion);
    const srcRow = await runtimePool.query<{
      id: string;
      visibility: string;
      repo_latest_snapshot: string | null;
    }>(
      `SELECT id, visibility, repo_latest_snapshot FROM apps WHERE id = $1`,
      [source_app_id],
    );
    const src = srcRow.rows[0];
    if (!src || src.visibility !== 'public') {
      return sourceNotFound(reply);
    }
    if (!src.repo_latest_snapshot) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Source app has no repo snapshot yet.',
        remediation: 'The source must run `butterbase repo push` at least once before it can be cloned.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }

    // 3. Validate env_var_values shape (same rules as startClone — same
    // validator function, in fact).
    const envShape = validateEnvVarValues(body.env_var_values);
    if (!envShape.ok) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: envShape.message,
        remediation: 'Send env_var_values as { fn_name: { KEY: "value" } }.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }

    // 4. Advisory name-collision check. Task 5's redeem handler re-checks
    // authoritatively via startClone once an authenticated user redeems.
    if (typeof body.name === 'string' && body.name.trim().length > 0) {
      const requestedName = body.name.trim();
      const collision = await app.controlDb.query<{ app_id: string }>(
        `SELECT app_id FROM org_app_index WHERE app_name = $1 LIMIT 1`,
        [requestedName],
      );
      if (collision.rows.length > 0) {
        return reply.code(409).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: `The app name "${requestedName}" is already taken.`,
          remediation: 'Pick a different name.',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        }));
      }
    }

    // 5. Park the configuration, encrypted, with a 60-minute TTL.
    const intent = await createCloneIntent(app.controlDb, {
      sourceAppId: source_app_id,
      destAppName: body.name,
      destRegion: body.dest_region,
      envVarValues: body.env_var_values,
      autoMintRequests: body.auto_mint_api_key,
      sourceIp: request.ip,
    });

    // 6. Return only the opaque id and expiry — never the secrets.
    return reply.send({
      intent_id: intent.id,
      expires_at: intent.expires_at.toISOString(),
    });
  });
}
