// Function management routes
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppResolver } from '../services/app-resolver.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { invalidateFunctionCache } from '../utils/cache-invalidation.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { RESOURCE_NOT_FOUND, VALIDATION_INVALID_SCHEMA } from '@butterbase/shared/error-types';
import { config } from '../config.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { requireUserId } from '../utils/require-auth.js';
import { incrementUsage } from '../services/usage-metering.js';
import { resolveOrganizationId } from '../services/org-resolver.js';
import { logFromRequest } from '../services/audit/with-audit.js';

const triggerEnum = z.enum(['http', 'cron', 's3_upload', 'webhook', 'websocket']);

const triggerInputSchema = z.object({
  type: triggerEnum,
  config: z.any().default({}),
  enabled: z.boolean().default(true),
});

const deployFunctionSchema = z.object({
  name: z.string().min(1).max(100),
  code: z.string().min(1),
  description: z.string().optional(),
  envVars: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  memoryLimitMb: z.number().int().positive().optional(),
  // Canonical multi-trigger shape. At most one trigger per type (DB unique index).
  triggers: z.array(triggerInputSchema).min(1).optional(),
  // Legacy single-trigger field — accepted for backward compatibility and
  // shimmed to a 1-element triggers array. Omitting both also works and
  // defaults to a single http trigger (matches pre-cutover behavior).
  trigger: z.object({ type: triggerEnum, config: z.any().default({}) }).optional(),
  agent_tool: z.boolean().default(false),
  agent_tool_description: z.string().max(500).optional(),
  agent_tool_mode: z.enum(['read_only', 'read_write']).default('read_only'),
  agent_tool_exposed_to: z.enum(['developer_only', 'end_user']).default('developer_only'),
  /** Phase 2: per-function gate for X-Butterbase-As-User impersonation. */
  allow_service_key_impersonation: z.boolean().default(true),
});

type TriggerInput = z.infer<typeof triggerInputSchema>;

function normalizeTriggers(body: z.infer<typeof deployFunctionSchema>): TriggerInput[] {
  if (body.triggers) return body.triggers;
  if (body.trigger) {
    return [{ type: body.trigger.type, config: body.trigger.config ?? {}, enabled: true }];
  }
  // Pre-cutover default: a missing trigger meant http.
  return [{ type: 'http', config: {}, enabled: true }];
}

// Secure-by-default for HTTP: if a deploy doesn't explicitly set auth, require it.
// Stored at deploy time (not inferred at invoke time) so existing rows stay
// untouched and explicit { auth: 'none' } / 'optional' is preserved.
function applyHttpAuthDefault(t: TriggerInput): TriggerInput {
  if (t.type !== 'http') return t;
  const cfg = (t.config ?? {}) as Record<string, unknown>;
  if (cfg.auth === undefined) return { ...t, config: { ...cfg, auth: 'required' } };
  return t;
}

function encryptWebhookSecret(t: TriggerInput): TriggerInput {
  if (t.type !== 'webhook') return t;
  const cfg = (t.config ?? {}) as Record<string, unknown>;
  if (typeof cfg.secret === 'string' && cfg.secret.length > 0) {
    return { ...t, config: { ...cfg, secret: encrypt(cfg.secret, process.env.AUTH_ENCRYPTION_KEY!) } };
  }
  return t;
}

function redactTriggerConfig(type: string, cfg: unknown): unknown {
  if (!cfg || typeof cfg !== 'object') return cfg;
  if (type === 'webhook') {
    const c = cfg as Record<string, unknown>;
    if (typeof c.secret === 'string') return { ...c, secret: '***' };
  }
  return cfg;
}

export async function registerFunctionRoutes(fastify: FastifyInstance) {
  const { controlDb } = fastify;
  // Per-request home-region resolution: each handler that needs the
  // runtime pool calls await runtimeDb(appId) (Redis-cached).
  const runtimeDb = (appId: string) => getRuntimeDbForApp(controlDb, appId);

  // Deploy or update a function
  fastify.post('/v1/:appId/functions', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const parsed = deployFunctionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        remediation: 'Check the request body against the function deployment schema.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }
    const body = parsed.data;

    // Validate app ownership
    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

    // Check if handler function is exported (Deno will validate actual syntax)
    if (!body.code.includes('export') || !body.code.includes('handler')) {
      return reply.status(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Function must export a handler function',
        remediation: 'Add "export async function handler(request, context) { ... }" to your function code.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA)
      }));
    }

    // Reject relative imports — they cannot be resolved in the blob worker environment
    // and cause the entire runtime process to crash (not just the single invocation).
    if (/from\s+["']\.(\.)?\//.test(body.code) || /import\s*\(\s*["']\.(\.)?\//.test(body.code)) {
      return reply.status(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Relative imports are not supported in Butterbase functions',
        remediation: 'Use absolute https:// URLs for imports (e.g. from "https://deno.land/...") or inline shared code directly.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA)
      }));
    }

    // Encrypt environment variables
    const encryptedEnvVars = body.envVars
      ? encrypt(JSON.stringify(body.envVars), process.env.AUTH_ENCRYPTION_KEY!)
      : null;

    // Normalize, apply HTTP-auth default, encrypt webhook secrets.
    const triggers = normalizeTriggers(body).map(applyHttpAuthDefault).map(encryptWebhookSecret);

    // Reject duplicate trigger types up front (also enforced by DB unique index).
    const seen = new Set<string>();
    for (const t of triggers) {
      if (seen.has(t.type)) {
        return reply.status(400).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: `Duplicate trigger type '${t.type}' — at most one trigger of each type per function.`,
          remediation: 'Combine the configs into a single trigger entry.',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        }));
      }
      seen.add(t.type);
    }

    // Upsert function row + replace its triggers in one transaction on the
    // runtime pool. app_functions and function_triggers both live in
    // runtime-plane, so a single connection covers both.
    const runtimePool = await runtimeDb(appId);
    const client = await runtimePool.connect();
    let fnResult: import('pg').QueryResult<{ id: string; name: string; deployed_at: Date }>;
    try {
      await client.query('BEGIN');

      fnResult = await client.query(
        `INSERT INTO app_functions (
          app_id, name, code, description, encrypted_env_vars,
          timeout_ms, memory_limit_mb, deployed_by,
          agent_tool, agent_tool_description, agent_tool_mode, agent_tool_exposed_to,
          allow_service_key_impersonation
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (app_id, name)
        DO UPDATE SET
          code = $3,
          description = COALESCE($4, app_functions.description),
          encrypted_env_vars = COALESCE($5, app_functions.encrypted_env_vars),
          timeout_ms = COALESCE($6, app_functions.timeout_ms),
          memory_limit_mb = COALESCE($7, app_functions.memory_limit_mb),
          deployed_at = now(),
          deployed_by = $8,
          deleted_at = NULL,
          updated_at = now(),
          agent_tool = $9,
          agent_tool_description = COALESCE($10, app_functions.agent_tool_description),
          agent_tool_mode = $11,
          agent_tool_exposed_to = $12,
          allow_service_key_impersonation = $13
        RETURNING id, name, deployed_at`,
        [
          appId, body.name, body.code, body.description ?? null, encryptedEnvVars,
          body.timeoutMs ?? 30000, body.memoryLimitMb ?? 128, requireUserId(request),
          body.agent_tool, body.agent_tool_description ?? null,
          body.agent_tool_mode, body.agent_tool_exposed_to,
          body.allow_service_key_impersonation,
        ],
      );

      const fnId = fnResult.rows[0].id;

      // Replace triggers wholesale: simpler than per-row diffing and matches
      // the "deploy" semantics — the request fully describes the function's
      // triggers.
      await client.query(`DELETE FROM function_triggers WHERE function_id = $1`, [fnId]);

      for (const t of triggers) {
        await client.query(
          `INSERT INTO function_triggers (function_id, app_id, trigger_type, trigger_config, enabled)
           VALUES ($1, $2, $3, $4, $5)`,
          [fnId, appId, t.type, JSON.stringify(t.config ?? {}), t.enabled],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const fn = fnResult.rows[0];

    // Invalidate Deno cache with retry
    const invalidationResult = await invalidateFunctionCache(appId, body.name);

    if (!invalidationResult.success) {
      console.error(
        `Cache invalidation failed after ${invalidationResult.attempts} attempts:`,
        invalidationResult.error
      );
      // Continue anyway - version check will catch stale cache
    }

    logFromRequest(request, {
      appId,
      category: 'admin',
      eventType: 'function.deploy',
      action: 'create',
      resourceType: 'function',
      resourceId: body.name,
      eventData: {
        function_id: fn.id,
        trigger_types: triggers.map((t) => t.type),
        env_var_keys: body.envVars ? Object.keys(body.envVars) : [],
      },
      success: true,
    });

    const httpTrigger = triggers.find((t) => t.type === 'http');
    return reply.send({
      id: fn.id,
      name: fn.name,
      url: httpTrigger ? `${config.apiBaseUrl}/v1/${appId}/fn/${body.name}` : null,
      triggers: triggers.map((t) => ({ type: t.type, enabled: t.enabled })),
      deployedAt: fn.deployed_at,
      cacheInvalidation: {
        success: invalidationResult.success,
        attempts: invalidationResult.attempts,
      },
    });
  });

  // Update function environment variables
  fastify.patch('/v1/:appId/functions/:name/env', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    const body = request.body as { envVars: Record<string, string> };

    // Validate app ownership
    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

    // Validate envVars
    if (!body.envVars || typeof body.envVars !== 'object') {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'envVars must be an object',
        remediation: 'Provide envVars as a key-value object. Example: {"API_KEY": "secret123"}',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA)
      }));
    }

    // Fetch existing env vars and merge with new ones (set a value to null to delete a key)
    const existing = await (await runtimeDb(appId)).query(
      `SELECT encrypted_env_vars FROM app_functions WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [appId, name]
    );

    if (existing.rows.length === 0) {
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Function not found',
        remediation: 'Verify the function name is correct. Use list_functions to see available functions.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
      }));
    }

    let mergedVars: Record<string, string> = {};
    if (existing.rows[0].encrypted_env_vars) {
      try {
        mergedVars = JSON.parse(decrypt(existing.rows[0].encrypted_env_vars, process.env.AUTH_ENCRYPTION_KEY!));
      } catch {
        // If decryption fails, start fresh
      }
    }

    // Merge: new values overwrite existing; null values delete keys
    for (const [key, value] of Object.entries(body.envVars)) {
      if (value === null || value === undefined) {
        delete mergedVars[key];
      } else {
        mergedVars[key] = value;
      }
    }

    const encryptedEnvVars = encrypt(JSON.stringify(mergedVars), process.env.AUTH_ENCRYPTION_KEY!);

    // Update only env vars
    const result = await (await runtimeDb(appId)).query(
      `UPDATE app_functions
       SET encrypted_env_vars = $1, updated_at = now()
       WHERE app_id = $2 AND name = $3 AND deleted_at IS NULL
       RETURNING id, name, updated_at`,
      [encryptedEnvVars, appId, name]
    );

    // Invalidate function cache
    const invalidationResult = await invalidateFunctionCache(appId, name);

    logFromRequest(request, {
      appId,
      category: 'admin',
      eventType: 'function.env.update',
      action: 'update',
      resourceType: 'function',
      resourceId: name,
      eventData: { env_var_keys: Object.keys(body.envVars) },
      success: true,
    });

    return reply.send({
      message: 'Environment variables updated successfully',
      function: result.rows[0],
      // Keys present after merge — dashboard uses this to refresh the chip list.
      updatedKeys: Object.keys(mergedVars),
      cache_invalidation: {
        success: invalidationResult.success,
        attempts: invalidationResult.attempts,
      },
    });
  });

  // PATCH /v1/:appId/functions/:name/settings — toggle per-function settings
  // without redeploying code. Currently only `allow_service_key_impersonation`
  // (Phase 2 impersonation gate), but the route is extensible for future
  // per-function knobs. Skips the encryption + re-deploy round-trip the
  // INSERT/ON CONFLICT path takes, so it's safe to call on hot functions.
  fastify.patch('/v1/:appId/functions/:name/settings', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    const body = request.body as { allow_service_key_impersonation?: boolean };

    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

    if (body.allow_service_key_impersonation === undefined) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Provide at least one setting to update',
        remediation: 'Currently supported: allow_service_key_impersonation (boolean).',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }

    const result = await (await runtimeDb(appId)).query(
      `UPDATE app_functions
         SET allow_service_key_impersonation = $1, updated_at = now()
       WHERE app_id = $2 AND name = $3 AND deleted_at IS NULL
       RETURNING id, name, allow_service_key_impersonation, updated_at`,
      [body.allow_service_key_impersonation, appId, name]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Function not found',
        remediation: 'Verify the function name. Use list_functions to see available functions.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }

    // Invalidate function cache so the runtime picks up the new flag on next
    // invocation. Without this, an in-cache metadata row would keep the old
    // `allow_service_key_impersonation` value until natural expiry (5 min).
    const invalidationResult = await invalidateFunctionCache(appId, name);

    logFromRequest(request, {
      appId,
      category: 'admin',
      eventType: 'function.settings.update',
      action: 'update',
      resourceType: 'function',
      resourceId: name,
      eventData: { allow_service_key_impersonation: body.allow_service_key_impersonation },
      success: true,
    });

    return reply.send({
      message: 'Function settings updated successfully',
      function: result.rows[0],
      cache_invalidation: {
        success: invalidationResult.success,
        attempts: invalidationResult.attempts,
      },
    });
  });

  // List functions for an app
  fastify.get('/v1/:appId/functions', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params as { appId: string };

    // Validate app ownership
    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

    const result = await (await runtimeDb(appId)).query(
      `SELECT
        f.id, f.name, f.description,
        f.deployed_at, f.last_invoked_at, f.last_status_code,
        f.invocation_count AS invocation_count_total,
        f.agent_tool, f.agent_tool_description, f.agent_tool_mode, f.agent_tool_exposed_to,
        f.allow_service_key_impersonation,
        COALESCE(stats.invocation_count_24h, 0) AS invocation_count_24h,
        COALESCE(stats.error_count_24h, 0) AS error_count_24h,
        stats.avg_duration_24h,
        COALESCE(
          (SELECT json_agg(json_build_object(
             'type', ft.trigger_type,
             'config', ft.trigger_config,
             'enabled', ft.enabled
           ) ORDER BY ft.trigger_type)
           FROM function_triggers ft WHERE ft.function_id = f.id),
          '[]'::json
        ) AS triggers
       FROM app_functions f
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*) AS invocation_count_24h,
           COUNT(*) FILTER (WHERE status_code >= 400) AS error_count_24h,
           AVG(duration_ms) AS avg_duration_24h
         FROM function_invocations
         WHERE function_id = f.id
           AND started_at > now() - interval '24 hours'
       ) stats ON TRUE
       WHERE f.app_id = $1 AND f.deleted_at IS NULL
       ORDER BY f.name`,
      [appId]
    );

    const functions = result.rows.map((row) => {
      const invocations24h = parseInt(row.invocation_count_24h);
      const errors24h = parseInt(row.error_count_24h);
      const errorRate = invocations24h > 0 ? errors24h / invocations24h : 0;
      const triggers = (row.triggers as Array<{ type: string; config: unknown; enabled: boolean }>)
        .map((t) => ({ ...t, config: redactTriggerConfig(t.type, t.config) }));
      const httpTrigger = triggers.find((t) => t.type === 'http');
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        triggers,
        url: httpTrigger ? `${config.apiBaseUrl}/v1/${appId}/fn/${row.name}` : null,
        status: errorRate > 0.1 ? 'error' : 'active',
        deployedAt: row.deployed_at,
        lastInvoked: row.last_invoked_at,
        lastStatus: row.last_status_code,
        invocationCount: parseInt(row.invocation_count_total),
        errorRate,
        avgDuration: parseFloat(row.avg_duration_24h) || 0,
        agent_tool: row.agent_tool,
        agent_tool_description: row.agent_tool_description,
        agent_tool_mode: row.agent_tool_mode,
        agent_tool_exposed_to: row.agent_tool_exposed_to,
      };
    });

    return reply.send({ functions });
  });

  // Get single function
  fastify.get('/v1/:appId/functions/:name', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };

    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

    const result = await (await runtimeDb(appId)).query(
      `SELECT f.*,
        COALESCE(
          (SELECT json_agg(json_build_object(
             'type', ft.trigger_type,
             'config', ft.trigger_config,
             'enabled', ft.enabled
           ) ORDER BY ft.trigger_type)
           FROM function_triggers ft WHERE ft.function_id = f.id),
          '[]'::json
        ) AS triggers
       FROM app_functions f
       WHERE f.app_id = $1 AND f.name = $2 AND f.deleted_at IS NULL`,
      [appId, name]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Function not found',
        remediation: 'Verify the function name is correct. Use list_functions to see deployed functions.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
      }));
    }

    const fn = result.rows[0];
    const triggers = (fn.triggers as Array<{ type: string; config: unknown; enabled: boolean }>)
      .map((t) => ({ ...t, config: redactTriggerConfig(t.type, t.config) }));
    // Surface env-var keys (not values) so dashboard/CLI can show what's
    // configured without re-deploying to find out. Values stay encrypted.
    let envKeys: string[] = [];
    if (fn.encrypted_env_vars) {
      try {
        envKeys = Object.keys(JSON.parse(decrypt(fn.encrypted_env_vars, process.env.AUTH_ENCRYPTION_KEY!)));
      } catch {
        // Treat unreadable blobs as no keys — better than 500'ing the detail page.
      }
    }
    return reply.send({
      id: fn.id,
      name: fn.name,
      description: fn.description,
      code: fn.code,
      triggers,
      timeoutMs: fn.timeout_ms,
      memoryLimitMb: fn.memory_limit_mb,
      deployedAt: fn.deployed_at,
      lastInvoked: fn.last_invoked_at,
      invocationCount: parseInt(fn.invocation_count),
      errorCount: parseInt(fn.error_count),
      avgDuration: parseFloat(fn.avg_duration_ms) || 0,
      agent_tool: fn.agent_tool,
      agent_tool_description: fn.agent_tool_description,
      agent_tool_mode: fn.agent_tool_mode,
      agent_tool_exposed_to: fn.agent_tool_exposed_to,
      envKeys,
    });
  });

  // Delete function
  fastify.delete('/v1/:appId/functions/:name', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };

    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

    await (await runtimeDb(appId)).query(
      `UPDATE app_functions SET deleted_at = now() WHERE app_id = $1 AND name = $2`,
      [appId, name]
    );

    // Invalidate cache with retry
    const invalidationResult = await invalidateFunctionCache(appId, name);

    if (!invalidationResult.success) {
      console.error(
        `Cache invalidation failed after ${invalidationResult.attempts} attempts:`,
        invalidationResult.error
      );
    }

    logFromRequest(request, {
      appId,
      category: 'admin',
      eventType: 'function.delete',
      action: 'delete',
      resourceType: 'function',
      resourceId: name,
      success: true,
    });

    return reply.send({ success: true });
  });

  // Test invoke function
  fastify.post('/v1/:appId/functions/:name/invoke', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };

    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

    // Optional impersonation: caller may pass X-Butterbase-As-User to invoke
    // the function with ctx.user set to that id. Gated by the per-function
    // allow_service_key_impersonation flag (defaults to true). Refuse the
    // header rather than silently dropping it — dropping would mask a
    // misconfiguration during RLS testing.
    const asUserHeader = request.headers['x-butterbase-as-user'];
    const asUser = Array.isArray(asUserHeader) ? asUserHeader[0] : asUserHeader;
    if (asUser) {
      const impersonationCheck = await (await runtimeDb(appId)).query(
        'SELECT allow_service_key_impersonation FROM app_functions WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL',
        [appId, name]
      );
      if (
        impersonationCheck.rows.length > 0 &&
        impersonationCheck.rows[0].allow_service_key_impersonation === false
      ) {
        return reply.status(403).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: 'Impersonation is disabled for this function.',
          remediation: 'Enable allow_service_key_impersonation on the function before invoking with X-Butterbase-As-User.',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA)
        }));
      }
    }

    // Track lambda invocation for billing
    const fnOwnerResult = await (await runtimeDb(appId)).query(
      'SELECT owner_id FROM apps WHERE id = $1',
      [appId]
    );
    if (fnOwnerResult.rows.length > 0) {
      const ownerId = fnOwnerResult.rows[0].owner_id;
      void (async () => {
        const organizationId = await resolveOrganizationId(controlDb, ownerId);
        await incrementUsage(organizationId, 'lambda_invocations', 1, appId);
      })();
    }

    // Forward to Deno runtime
    const invokeStart = Date.now();
    let denoResponse: Response;
    try {
      // When impersonating, x-user-id (the runtime's effective-user header)
      // becomes the asserted id, and we mark the caller as a service-key
      // impersonator so functions that branch on ctx.caller.type can react.
      const runtimeHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-user-id': asUser || requireUserId(request),
        'x-app-id': appId,
      };
      if (asUser) {
        runtimeHeaders['x-butterbase-caller-type'] = 'service_key';
        runtimeHeaders['x-butterbase-as-user'] = asUser;
      }
      denoResponse = await fetch(
        `${config.runtimeUrl}/execute/${appId}/${name}`,
        {
          method: 'POST',
          headers: runtimeHeaders,
          body: request.body != null ? JSON.stringify(request.body) : JSON.stringify({}),
        }
      );
    } catch (err) {
      logFromRequest(request, {
        appId,
        category: 'function',
        eventType: 'function.invoke',
        action: 'invoke',
        resourceType: 'function',
        resourceId: name,
        eventData: {
          duration_ms: Date.now() - invokeStart,
          runtime_error: (err as Error).message,
        },
        success: false,
        errorMessage: (err as Error).message,
      });
      throw err;
    }

    const contentType = denoResponse.headers.get('content-type') || 'application/json';
    const isStream = contentType.toLowerCase().startsWith('text/event-stream');

    logFromRequest(request, {
      appId,
      category: 'function',
      eventType: 'function.invoke',
      action: 'invoke',
      resourceType: 'function',
      resourceId: name,
      eventData: {
        duration_ms: Date.now() - invokeStart,
        status_code: denoResponse.status,
        streaming: isStream,
      },
      success: denoResponse.ok,
      errorMessage: denoResponse.ok ? null : `HTTP ${denoResponse.status}`,
    });

    if (isStream && denoResponse.body) {
      // Passthrough SSE: hijack the reply so Fastify doesn't add a
      // Content-Length (which would collide with Transfer-Encoding: chunked).
      // Matches the existing pattern in routes/frontend-from-source.ts.
      reply.raw.statusCode = denoResponse.status;
      reply.raw.setHeader('content-type', contentType);
      reply.raw.setHeader('cache-control', 'no-cache, no-transform');
      reply.raw.setHeader('connection', 'keep-alive');
      reply.raw.setHeader('x-accel-buffering', 'no');
      reply.hijack();
      const reader = denoResponse.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          reply.raw.write(value);
        }
      } catch {
        // Client disconnected mid-stream — nothing to do.
      } finally {
        reply.raw.end();
      }
      return;
    }

    const responseBody = await denoResponse.text();
    return reply
      .status(denoResponse.status)
      .header('content-type', contentType)
      .send(responseBody);
  });

  // Get function logs
  fastify.get('/v1/:appId/functions/:name/logs', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    const { limit = 100, since, level, include_deleted } = request.query as {
      limit?: number;
      since?: string;
      level?: 'error' | 'all';
      include_deleted?: boolean | string;
    };

    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

    const includeDeleted = include_deleted === true || include_deleted === 'true';

    const fnResult = await (await runtimeDb(appId)).query(
      includeDeleted
        ? `SELECT id FROM app_functions WHERE app_id = $1 AND name = $2`
        : `SELECT id FROM app_functions WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [appId, name]
    );

    if (fnResult.rows.length === 0) {
      return reply.status(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Function not found',
        remediation: includeDeleted
          ? 'No function with that name has ever existed for this app (including soft-deleted).'
          : 'Verify the function name is correct. Use list_functions to see deployed functions, or pass include_deleted=true to read logs from a soft-deleted function.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
      }));
    }

    const functionId = fnResult.rows[0].id;

    // Build query
    let query = `
      SELECT
        id, method, path, status_code, duration_ms, memory_used_mb,
        error_message, error_stack, console_logs, started_at, completed_at
      FROM function_invocations
      WHERE function_id = $1
    `;
    const params: unknown[] = [functionId];

    if (since) {
      params.push(since);
      query += ` AND started_at > $${params.length}`;
    }

    if (level === 'error') {
      query += ` AND error_message IS NOT NULL`;
    }

    query += ` ORDER BY started_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await (await runtimeDb(appId)).query(query, params);

    const logs = result.rows.map((row) => ({
      timestamp: row.started_at,
      method: row.method,
      path: row.path,
      statusCode: row.status_code,
      duration: row.duration_ms,
      memoryUsed: parseFloat(row.memory_used_mb),
      error: row.error_message,
      stack: row.error_stack,
      consoleLogs: row.console_logs || [],
    }));

    return reply.send({
      logs,
      hasMore: result.rows.length === limit,
    });
  });

  // Tail function logs over SSE. Polls function_invocations every ~2s and
  // emits new rows as `log` events. Each row uses its UTC timestamp as the
  // cursor; on reconnect the client passes last_event_id to resume without
  // gaps. Closes when the client disconnects.
  fastify.get(
    '/v1/:appId/functions/:name/logs/stream',
    { config: { requiresAppRegion: true, migrationGuard: true } },
    async (request, reply) => {
      const { appId, name } = request.params as { appId: string; name: string };
      const { since, level } = request.query as {
        since?: string;
        level?: 'error' | 'all';
      };

      await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

      const fnResult = await (await runtimeDb(appId)).query(
        'SELECT id FROM app_functions WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL',
        [appId, name]
      );
      if (fnResult.rows.length === 0) {
        return reply.status(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'Function not found',
          remediation: 'Verify the function name. Use list_functions to see deployed functions.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
        }));
      }
      const functionId = fnResult.rows[0].id;

      reply.raw.statusCode = 200;
      reply.raw.setHeader('content-type', 'text/event-stream');
      reply.raw.setHeader('cache-control', 'no-cache, no-transform');
      reply.raw.setHeader('connection', 'keep-alive');
      // Disable buffering for nginx / cloudflare so chunks reach the client.
      reply.raw.setHeader('x-accel-buffering', 'no');
      reply.hijack();

      // Resume cursor: prefer last_event_id from EventSource auto-reconnect,
      // then explicit ?since=, then "now" so we don't dump backlog on first
      // open. Stored as ISO so we can pass it straight back into started_at>.
      const lastEventId = request.headers['last-event-id'];
      let cursor: string = (Array.isArray(lastEventId) ? lastEventId[0] : lastEventId)
        || since
        || new Date().toISOString();

      // Keep-alive comment every 15s so intermediaries don't reap the
      // connection on idle.
      const keepAlive = setInterval(() => {
        if (!reply.raw.writableEnded) reply.raw.write(': keepalive\n\n');
      }, 15_000);

      let closed = false;
      const onClose = () => {
        closed = true;
        clearInterval(keepAlive);
      };
      request.raw.once('close', onClose);

      try {
        while (!closed && !reply.raw.writableEnded) {
          const params: unknown[] = [functionId, cursor];
          let q = `
            SELECT
              id, method, path, status_code, duration_ms, memory_used_mb,
              error_message, error_stack, console_logs, started_at
            FROM function_invocations
            WHERE function_id = $1 AND started_at > $2
          `;
          if (level === 'error') q += ' AND error_message IS NOT NULL';
          q += ' ORDER BY started_at ASC LIMIT 100';

          const rows = (await (await runtimeDb(appId)).query(q, params)).rows;
          for (const row of rows) {
            const log = {
              timestamp: row.started_at,
              method: row.method,
              path: row.path,
              statusCode: row.status_code,
              duration: row.duration_ms,
              memoryUsed: parseFloat(row.memory_used_mb),
              error: row.error_message,
              stack: row.error_stack,
              consoleLogs: row.console_logs || [],
            };
            const iso = row.started_at instanceof Date
              ? row.started_at.toISOString()
              : String(row.started_at);
            cursor = iso;
            reply.raw.write(`id: ${iso}\nevent: log\ndata: ${JSON.stringify(log)}\n\n`);
          }

          if (closed) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
      } finally {
        clearInterval(keepAlive);
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    }
  );
}
