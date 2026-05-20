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
import { logFromRequest } from '../services/audit/with-audit.js';

const deployFunctionSchema = z.object({
  name: z.string().min(1).max(100),
  code: z.string().min(1),
  description: z.string().optional(),
  envVars: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  memoryLimitMb: z.number().int().positive().optional(),
  trigger: z.object({
    type: z.enum(['http', 'cron', 's3_upload', 'webhook', 'websocket']),
    config: z.any(),
  }).optional(),
});

export async function registerFunctionRoutes(fastify: FastifyInstance) {
  const { controlDb } = fastify;
  // Per-request home-region resolution: each handler that needs the
  // runtime pool calls await runtimeDb(appId) (Redis-cached).
  const runtimeDb = (appId: string) => getRuntimeDbForApp(controlDb, appId);

  // Deploy or update a function
  fastify.post('/v1/:appId/functions', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const body = deployFunctionSchema.parse(request.body);

    // Validate app ownership
    const app = await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

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

    // Secure-by-default: new HTTP functions require JWT unless caller opts out.
    // Stored at deploy time (not inferred at invoke time) so existing rows are
    // unaffected and explicit { auth: 'none' } / 'optional' is preserved.
    const triggerType = body.trigger?.type || 'http';
    const triggerConfigInput = (body.trigger?.config ?? {}) as Record<string, unknown>;
    const triggerConfig = triggerType === 'http' && triggerConfigInput.auth === undefined
      ? { ...triggerConfigInput, auth: 'required' }
      : triggerConfigInput;

    // Upsert function
    const result = await (await runtimeDb(appId)).query(
      `INSERT INTO app_functions (
        app_id, name, code, description, encrypted_env_vars,
        timeout_ms, memory_limit_mb, trigger_type, trigger_config,
        deployed_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (app_id, name)
      DO UPDATE SET
        code = $3,
        description = COALESCE($4, app_functions.description),
        encrypted_env_vars = COALESCE($5, app_functions.encrypted_env_vars),
        timeout_ms = COALESCE($6, app_functions.timeout_ms),
        memory_limit_mb = COALESCE($7, app_functions.memory_limit_mb),
        trigger_type = COALESCE($8, app_functions.trigger_type),
        trigger_config = COALESCE($9, app_functions.trigger_config),
        deployed_at = now(),
        deployed_by = $10,
        deleted_at = NULL,
        updated_at = now()
      RETURNING id, name, deployed_at`,
      [
        appId,
        body.name,
        body.code,
        body.description || null,
        encryptedEnvVars,
        body.timeoutMs || 30000,
        body.memoryLimitMb || 128,
        triggerType,
        JSON.stringify(triggerConfig),
        requireUserId(request),
      ]
    );

    const fn = result.rows[0];

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
        trigger_type: triggerType,
        env_var_keys: body.envVars ? Object.keys(body.envVars) : [],
      },
      success: true,
    });

    return reply.send({
      id: fn.id,
      name: fn.name,
      url: `${config.apiBaseUrl}/v1/${appId}/fn/${body.name}`,
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
        f.id, f.name, f.description, f.trigger_type, f.trigger_config,
        f.deployed_at, f.last_invoked_at, f.last_status_code,
        f.invocation_count AS invocation_count_total,
        COALESCE(stats.invocation_count_24h, 0) AS invocation_count_24h,
        COALESCE(stats.error_count_24h, 0) AS error_count_24h,
        stats.avg_duration_24h
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
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        trigger: {
          type: row.trigger_type,
          config: row.trigger_config,
        },
        url: row.trigger_type === 'http' ? `${config.apiBaseUrl}/v1/${appId}/fn/${row.name}` : null,
        status: errorRate > 0.1 ? 'error' : 'active',
        deployedAt: row.deployed_at,
        lastInvoked: row.last_invoked_at,
        lastStatus: row.last_status_code,
        invocationCount: parseInt(row.invocation_count_total),
        errorRate,
        avgDuration: parseFloat(row.avg_duration_24h) || 0,
      };
    });

    return reply.send({ functions });
  });

  // Get single function
  fastify.get('/v1/:appId/functions/:name', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };

    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

    const result = await (await runtimeDb(appId)).query(
      `SELECT * FROM app_functions WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL`,
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
    return reply.send({
      id: fn.id,
      name: fn.name,
      description: fn.description,
      code: fn.code,
      trigger: {
        type: fn.trigger_type,
        config: fn.trigger_config,
      },
      timeoutMs: fn.timeout_ms,
      memoryLimitMb: fn.memory_limit_mb,
      deployedAt: fn.deployed_at,
      lastInvoked: fn.last_invoked_at,
      invocationCount: parseInt(fn.invocation_count),
      errorCount: parseInt(fn.error_count),
      avgDuration: parseFloat(fn.avg_duration_ms) || 0,
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

    // Track lambda invocation for billing
    const fnOwnerResult = await (await runtimeDb(appId)).query(
      'SELECT owner_id FROM apps WHERE id = $1',
      [appId]
    );
    if (fnOwnerResult.rows.length > 0) {
      incrementUsage(fnOwnerResult.rows[0].owner_id, 'lambda_invocations', 1, appId);
    }

    // Forward to Deno runtime
    const invokeStart = Date.now();
    let denoResponse: Response;
    try {
      denoResponse = await fetch(
        `${config.runtimeUrl}/execute/${appId}/${name}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-id': requireUserId(request),
            'x-app-id': appId,
          },
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

    const responseBody = await denoResponse.text();
    const contentType = denoResponse.headers.get('content-type') || 'application/json';

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
      },
      success: denoResponse.ok,
      errorMessage: denoResponse.ok ? null : `HTTP ${denoResponse.status}`,
    });

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
    const params: any[] = [functionId];

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
}
