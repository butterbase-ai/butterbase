// App-level environment variable routes
import type { FastifyInstance } from 'fastify';
import { AppResolver } from '../services/app-resolver.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { invalidateFunctionCache } from '../utils/cache-invalidation.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { VALIDATION_INVALID_SCHEMA } from '@butterbase/shared/error-types';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { requireUserId } from '../utils/require-auth.js';
import { logFromRequest } from '../services/audit/with-audit.js';
import { validateEnvKeys } from '../lib/env-vars.js';
import { redeployIfActive } from '../services/durable-objects.service.js';

export async function registerAppEnvRoutes(fastify: FastifyInstance) {
  const { controlDb } = fastify;
  const runtimeDb = (appId: string) => getRuntimeDbForApp(controlDb, appId);

  // GET app-level env var keys (never returns values)
  fastify.get('/v1/:appId/env', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    await AppResolver.resolveApp(controlDb, appId, requireUserId(request), request.auth?.organizationId ?? null);

    const row = await (await runtimeDb(appId)).query(
      `SELECT encrypted_env_vars, updated_at FROM app_env_vars WHERE app_id = $1`,
      [appId]
    );

    if (row.rows.length === 0) {
      return reply.send({ keys: [], updatedAt: null });
    }

    let keys: string[] = [];
    try {
      const decoded = JSON.parse(decrypt(row.rows[0].encrypted_env_vars, process.env.AUTH_ENCRYPTION_KEY!));
      keys = Object.keys(decoded);
    } catch (err) {
      // Corrupt blob or rotated encryption key. Return empty keys (safe) but
      // warn so ops can spot silent-corruption before a user re-enters and
      // overwrites the still-recoverable ciphertext.
      request.log.warn(
        { app_id: appId, err: err instanceof Error ? err.message : String(err) },
        '[app-env] decrypt failed on GET — returning empty keys'
      );
      keys = [];
    }
    return reply.send({ keys, updatedAt: row.rows[0].updated_at });
  });

  // PATCH app-level env vars (merge; null value deletes)
  fastify.patch('/v1/:appId/env', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const body = request.body as { envVars: Record<string, string | null> };
    const userId = requireUserId(request);

    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);

    if (!body.envVars || typeof body.envVars !== 'object' || Array.isArray(body.envVars)) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'envVars must be a non-empty object',
        remediation: 'Provide envVars as a key-value object with at least one key. Example: {"STRIPE_SECRET": "sk_..."}',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }

    if (Object.keys(body.envVars).length === 0) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'envVars must contain at least one key',
        remediation: 'Include at least one key to set (STRING) or delete (null).',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }

    const badKey = validateEnvKeys(Object.keys(body.envVars));
    if (badKey) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: `Reserved key: "${badKey.key}" — keys starting with BUTTERBASE_ are reserved for platform use`,
        remediation: 'Rename the key.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }

    const db = await runtimeDb(appId);

    // Load existing blob
    const existing = await db.query(
      `SELECT encrypted_env_vars FROM app_env_vars WHERE app_id = $1`,
      [appId]
    );
    let merged: Record<string, string> = {};
    if (existing.rows[0]?.encrypted_env_vars) {
      try {
        merged = JSON.parse(decrypt(existing.rows[0].encrypted_env_vars, process.env.AUTH_ENCRYPTION_KEY!));
      } catch { merged = {}; }
    }

    const setKeys: string[] = [];
    const deletedKeys: string[] = [];
    for (const [k, v] of Object.entries(body.envVars)) {
      if (v === null || v === undefined) {
        delete merged[k];
        deletedKeys.push(k);
      } else {
        merged[k] = v;
        setKeys.push(k);
      }
    }

    const encrypted = encrypt(JSON.stringify(merged), process.env.AUTH_ENCRYPTION_KEY!);

    await db.query(
      `INSERT INTO app_env_vars (app_id, encrypted_env_vars, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (app_id) DO UPDATE
         SET encrypted_env_vars = EXCLUDED.encrypted_env_vars,
             updated_at         = now(),
             updated_by         = EXCLUDED.updated_by`,
      [appId, encrypted, userId]
    );

    // Fan out cache invalidation to every function in this app.
    // Use allSettled so a Redis blip on one key does not fail the whole request —
    // the 5-min LRU TTL is the durability backstop.
    const fns = await db.query(
      `SELECT name FROM app_functions WHERE app_id = $1 AND deleted_at IS NULL`,
      [appId]
    );
    const fnNames = fns.rows.map((r: { name: string }) => r.name);
    const settled = await Promise.allSettled(fnNames.map((n) => invalidateFunctionCache(appId, n)));

    const invalidatedFns: string[] = [];
    const failedFns: string[] = [];
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'fulfilled') {
        invalidatedFns.push(fnNames[i]);
      } else {
        failedFns.push(fnNames[i]);
        console.warn(
          `[app-env] cache invalidation failed for app=${appId} fn=${fnNames[i]}:`,
          (settled[i] as PromiseRejectedResult).reason
        );
      }
    }

    let doRedeployed = false;
    try {
      doRedeployed = await redeployIfActive(db, controlDb, appId);
    } catch (err) {
      request.log.warn(
        { app_id: appId, err: err instanceof Error ? err.message : String(err) },
        '[app-env] DO redeploy failed after env update; deployed DOs still see stale values',
      );
    }

    logFromRequest(request, {
      appId,
      category: 'admin',
      eventType: 'app.env.update',
      action: 'update',
      resourceType: 'app',
      resourceId: appId,
      eventData: { env_var_keys: Object.keys(body.envVars), set_keys: setKeys, deleted_keys: deletedKeys },
      success: true,
    });

    return reply.send({
      message: 'App-level environment variables updated successfully',
      updatedKeys: Object.keys(merged),
      invalidated: {
        functions: invalidatedFns,
        ...(failedFns.length > 0 ? { failed: failedFns } : {}),
        count: invalidatedFns.length,
        durable_objects_redeployed: doRedeployed,
      },
    });
  });
}
