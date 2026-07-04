import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';
import { createAgentError, getDocUrl, isHttpError } from '../services/error-handler.js';
import { RESOURCE_NOT_FOUND, VALIDATION_INVALID_SCHEMA, EXTERNAL_DB_ERROR } from '@butterbase/shared/error-types';
import { requireUserId } from '../utils/require-auth.js';
import { logFromRequest } from '../services/audit/with-audit.js';
import { config } from '../config.js';
import { resolveAppHomeRegion } from '../services/region-resolver.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';

const updateCorsSchema = z.object({
  allowed_origins: z.array(z.string().url()).min(1),
});

const updateJwtConfigSchema = z.object({
  accessTokenTtl: z.string().optional(),
  refreshTokenTtlDays: z.number().int().positive().optional(),
});

const updateStorageConfigSchema = z.object({
  publicReadEnabled: z.boolean(),
});

const updateAuthHooksSchema = z.object({
  post_auth_function: z.string().nullable(),
});

const updateAccessModeSchema = z.object({
  access_mode: z.enum(['public', 'authenticated']),
});

const updateVisibilitySchema = z.object({
  visibility: z.enum(['private', 'public']),
  listed: z.boolean().optional(),
});

const updatePausedSchema = z.object({
  paused: z.boolean(),
  reason: z.string().max(500).optional(),
});

const secureAppSchema = z.object({
  tables: z.array(z.object({
    table_name: z.string(),
    user_column: z.string(),
    public_read_column: z.string().optional(),
  })).optional().default([]),
});

export async function appConfigRoutes(app: FastifyInstance) {
  // GET /v1/:app_id/config - Get app configuration including CORS
  app.get('/v1/:app_id/config', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);
      const region = await resolveAppHomeRegion(app.controlDb, resolvedApp.id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

      const result = await runtimeDb.query(
        `SELECT id, name, db_name, db_provisioned, region, allowed_origins, storage_config, auth_hook_function, access_mode,
                visibility, listed, template_source_app_id, repo_latest_snapshot, fork_count,
                substrate_organization_id,
                created_at, updated_at
         FROM apps
         WHERE id = $1`,
        [resolvedApp.id]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }

      return reply.send(result.rows[0]);
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }
      app.log.error({ err: error }, 'Failed to get app config');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to get app config',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });

  // PATCH /v1/:app_id/config/cors - Update CORS allowed origins
  app.patch('/v1/:app_id/config/cors', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    // Validate request body
    const parseResult = updateCorsSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Invalid request body',
        remediation: 'Review the validation errors in the details field. Ensure allowed_origins is an array of valid URLs.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        details: parseResult.error.errors
      }));
    }

    const { allowed_origins } = parseResult.data;

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);
      const region = await resolveAppHomeRegion(app.controlDb, resolvedApp.id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

      // Update allowed_origins
      await runtimeDb.query(
        `UPDATE apps
         SET allowed_origins = $1, updated_at = now()
         WHERE id = $2`,
        [allowed_origins, resolvedApp.id]
      );

      logFromRequest(request, {
        appId: resolvedApp.id,
        category: 'admin',
        eventType: 'app.config.cors',
        action: 'update',
        resourceType: 'app_config',
        resourceId: 'cors',
        eventData: { allowed_origins },
        success: true,
      });

      return reply.send({
        message: 'CORS configuration updated successfully',
        app_id: resolvedApp.id,
        allowed_origins,
      });
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }
      app.log.error({ error }, 'Failed to update CORS config');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to update CORS config',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });

  // PATCH /v1/:app_id/config/jwt - Update JWT token configuration
  app.patch('/v1/:app_id/config/jwt', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    // Validate request body
    const parseResult = updateJwtConfigSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Invalid request body',
        remediation: 'Review the validation errors in the details field. Ensure accessTokenTtl is a valid duration string and refreshTokenTtlDays is a positive integer.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        details: parseResult.error.errors
      }));
    }

    const { accessTokenTtl, refreshTokenTtlDays } = parseResult.data;

    // Validate TTL format if provided
    if (accessTokenTtl) {
      const ttlMatch = accessTokenTtl.match(/^(\d+)([smhd])$/);
      if (!ttlMatch) {
        return reply.code(400).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: 'Invalid accessTokenTtl format',
          remediation: 'Use format like "15m", "1h", "2h", "1d". Supported units: s (seconds), m (minutes), h (hours), d (days).',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA)
        }));
      }
    }

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);
      const region = await resolveAppHomeRegion(app.controlDb, resolvedApp.id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

      // Get current config
      const currentResult = await runtimeDb.query(
        `SELECT jwt_config FROM apps WHERE id = $1`,
        [resolvedApp.id]
      );

      const currentConfig = currentResult.rows[0]?.jwt_config || {
        accessTokenTtl: '1h',
        refreshTokenTtlDays: 7,
      };

      // Merge with new values
      const newConfig = {
        accessTokenTtl: accessTokenTtl || currentConfig.accessTokenTtl,
        refreshTokenTtlDays: refreshTokenTtlDays !== undefined ? refreshTokenTtlDays : currentConfig.refreshTokenTtlDays,
      };

      // Update config
      await runtimeDb.query(
        `UPDATE apps
         SET jwt_config = $1, updated_at = now()
         WHERE id = $2`,
        [JSON.stringify(newConfig), resolvedApp.id]
      );

      logFromRequest(request, {
        appId: resolvedApp.id,
        category: 'admin',
        eventType: 'app.config.jwt',
        action: 'update',
        resourceType: 'app_config',
        resourceId: 'jwt',
        eventData: newConfig,
        success: true,
      });

      return reply.send({
        message: 'JWT configuration updated successfully',
        app_id: resolvedApp.id,
        jwt_config: newConfig,
      });
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }
      app.log.error({ error }, 'Failed to update JWT config');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to update JWT config',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });

  // PATCH /v1/:app_id/config/storage - Update storage configuration
  app.patch('/v1/:app_id/config/storage', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    // Validate request body
    const parseResult = updateStorageConfigSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Invalid request body',
        remediation: 'Review the validation errors in the details field. Ensure publicReadEnabled is a boolean.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        details: parseResult.error.errors
      }));
    }

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);
      const region = await resolveAppHomeRegion(app.controlDb, resolvedApp.id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

      // Get current storage config
      const currentResult = await runtimeDb.query(
        `SELECT storage_config FROM apps WHERE id = $1`,
        [resolvedApp.id]
      );

      const currentConfig = currentResult.rows[0]?.storage_config || {
        maxFileSizeMb: 10,
        allowedContentTypes: ['*/*'],
        publicReadEnabled: false,
      };

      // Merge with new values
      const newConfig = {
        ...currentConfig,
        ...parseResult.data,
      };

      // Update config
      await runtimeDb.query(
        `UPDATE apps
         SET storage_config = $1, updated_at = now()
         WHERE id = $2`,
        [JSON.stringify(newConfig), resolvedApp.id]
      );

      logFromRequest(request, {
        appId: resolvedApp.id,
        category: 'admin',
        eventType: 'app.config.storage',
        action: 'update',
        resourceType: 'app_config',
        resourceId: 'storage',
        eventData: { publicReadEnabled: newConfig.publicReadEnabled },
        success: true,
      });

      return reply.send({
        message: 'Storage configuration updated successfully',
        app_id: resolvedApp.id,
        storage_config: newConfig,
      });
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }
      app.log.error({ error }, 'Failed to update storage config');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to update storage config',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });

  // PATCH /v1/:app_id/config/auth-hooks - Configure post-auth hook function
  app.patch('/v1/:app_id/config/auth-hooks', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    const parseResult = updateAuthHooksSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Invalid request body',
        remediation: 'Provide post_auth_function as a string (function name) or null to remove the hook.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        details: parseResult.error.errors,
      }));
    }

    const { post_auth_function } = parseResult.data;

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);
      const region = await resolveAppHomeRegion(app.controlDb, resolvedApp.id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

      // If setting a function, verify it exists and is deployed
      if (post_auth_function) {
        const fnResult = await runtimeDb.query(
          'SELECT id FROM app_functions WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL',
          [resolvedApp.id, post_auth_function]
        );
        if (fnResult.rows.length === 0) {
          return reply.code(400).send(createAgentError({
            code: VALIDATION_INVALID_SCHEMA,
            message: `Function "${post_auth_function}" not found`,
            remediation: 'Deploy the function first using deploy_function, then configure it as the auth hook.',
            documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
          }));
        }
      }

      await runtimeDb.query(
        'UPDATE apps SET auth_hook_function = $1, updated_at = now() WHERE id = $2',
        [post_auth_function, resolvedApp.id]
      );

      logFromRequest(request, {
        appId: resolvedApp.id,
        category: 'admin',
        eventType: 'app.config.auth_hooks',
        action: 'update',
        resourceType: 'app_config',
        resourceId: 'auth_hooks',
        eventData: { post_auth_function },
        success: true,
      });

      return reply.send({
        auth_hook_function: post_auth_function,
        message: post_auth_function
          ? `Post-auth hook set to function "${post_auth_function}"`
          : 'Post-auth hook removed',
      });
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }
      app.log.error({ error }, 'Failed to update auth hooks config');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to update auth hooks config',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });

  // PATCH /v1/:app_id/config/access-mode - Toggle app access mode
  app.patch('/v1/:app_id/config/access-mode', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    const parseResult = updateAccessModeSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Invalid request body',
        remediation: 'Provide access_mode as either "public" or "authenticated".',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        details: parseResult.error.errors,
      }));
    }

    const { access_mode } = parseResult.data;

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);
      const region = await resolveAppHomeRegion(app.controlDb, resolvedApp.id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

      await runtimeDb.query(
        'UPDATE apps SET access_mode = $1, updated_at = now() WHERE id = $2',
        [access_mode, resolvedApp.id]
      );

      logFromRequest(request, {
        appId: resolvedApp.id,
        category: 'admin',
        eventType: 'app.config.access_mode',
        action: 'update',
        resourceType: 'app_config',
        resourceId: 'access_mode',
        eventData: { access_mode },
        success: true,
      });

      return reply.send({
        message: `Access mode updated to "${access_mode}"`,
        app_id: resolvedApp.id,
        access_mode,
      });
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }
      app.log.error({ error }, 'Failed to update access mode');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to update access mode',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });

  // PATCH /v1/:app_id/config/visibility - Toggle template visibility
  app.patch('/v1/:app_id/config/visibility', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    const parseResult = updateVisibilitySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Invalid request body',
        remediation: 'Provide visibility as "public" or "private". Optionally include listed (boolean).',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        details: parseResult.error.errors,
      }));
    }

    const { visibility, listed } = parseResult.data;

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);
      const region = await resolveAppHomeRegion(app.controlDb, resolvedApp.id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

      // Update visibility (and listed if provided) in a single statement.
      const update = listed === undefined
        ? await runtimeDb.query(
            `UPDATE apps SET visibility = $1, updated_at = now()
             WHERE id = $2
             RETURNING visibility, listed`,
            [visibility, resolvedApp.id]
          )
        : await runtimeDb.query(
            `UPDATE apps SET visibility = $1, listed = $2, updated_at = now()
             WHERE id = $3
             RETURNING visibility, listed`,
            [visibility, listed, resolvedApp.id]
          );

      const row = update.rows[0];

      logFromRequest(request, {
        appId: resolvedApp.id,
        category: 'admin',
        eventType: 'app.config.visibility',
        action: 'update',
        resourceType: 'app_config',
        resourceId: 'visibility',
        eventData: { visibility: row.visibility, listed: row.listed },
        success: true,
      });

      return reply.send({
        message: `Visibility updated to "${row.visibility}"`,
        app_id: resolvedApp.id,
        visibility: row.visibility,
        listed: row.listed,
      });
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }
      app.log.error({ error }, 'Failed to update visibility');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to update visibility',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });

  // PATCH /v1/:app_id/config/pause - Pause / resume the app (kill-switch)
  app.patch('/v1/:app_id/config/pause', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    const parseResult = updatePausedSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Invalid request body',
        remediation: 'Provide paused as a boolean. Optionally include a reason string (max 500 chars) describing why.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        details: parseResult.error.errors,
      }));
    }

    const { paused, reason } = parseResult.data;

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);
      const region = await resolveAppHomeRegion(app.controlDb, resolvedApp.id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

      const result = await runtimeDb.query(
        `UPDATE apps
         SET paused = $1,
             paused_at = CASE WHEN $1 THEN now() ELSE NULL END,
             paused_reason = CASE WHEN $1 THEN $2 ELSE NULL END,
             updated_at = now()
         WHERE id = $3
         RETURNING paused, paused_at, paused_reason`,
        [paused, reason ?? null, resolvedApp.id]
      );

      logFromRequest(request, {
        appId: resolvedApp.id,
        category: 'admin',
        eventType: 'app.config.paused',
        action: 'update',
        resourceType: 'app_config',
        resourceId: 'paused',
        eventData: { paused, reason: reason ?? null },
        success: true,
      });

      return reply.send({
        message: paused
          ? `App paused${reason ? ` (${reason})` : ''}. Data-plane traffic will return 503 until resumed.`
          : 'App resumed. Data-plane traffic restored.',
        app_id: resolvedApp.id,
        paused: result.rows[0].paused,
        paused_at: result.rows[0].paused_at,
        paused_reason: result.rows[0].paused_reason,
      });
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }
      app.log.error({ error }, 'Failed to update paused state');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to update paused state',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });

  // POST /v1/:app_id/secure - Composite: set access_mode + create RLS policies
  app.post('/v1/:app_id/secure', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    const parseResult = secureAppSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Invalid request body',
        remediation: 'Provide an optional "tables" array with objects containing table_name, user_column, and optional public_read_column.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        details: parseResult.error.errors,
      }));
    }

    const { tables } = parseResult.data;

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);
      const region = await resolveAppHomeRegion(app.controlDb, resolvedApp.id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

      // 1. Set access_mode to authenticated
      await runtimeDb.query(
        'UPDATE apps SET access_mode = $1, updated_at = now() WHERE id = $2',
        ['authenticated', resolvedApp.id]
      );

      // 2. For each table, call the existing RLS user isolation endpoint via inject
      const tablesSecured: Array<{ table: string; policy: string; public_read_policies?: string[] }> = [];
      const tableErrors: Array<{ table: string; error: string }> = [];

      for (const tableSpec of tables) {
        const rlsResponse = await app.inject({
          method: 'POST',
          url: `/v1/${app_id}/rls`,
          headers: {
            authorization: request.headers.authorization,
            'content-type': 'application/json',
          },
          payload: {
            table_name: tableSpec.table_name,
            user_column: tableSpec.user_column,
            ...(tableSpec.public_read_column && { public_read_column: tableSpec.public_read_column }),
          },
        });

        if (rlsResponse.statusCode >= 200 && rlsResponse.statusCode < 300) {
          const body = JSON.parse(rlsResponse.body);
          tablesSecured.push({
            table: tableSpec.table_name,
            policy: body.policy_name,
            ...(body.public_read_policies && { public_read_policies: body.public_read_policies }),
          });
        } else {
          const body = JSON.parse(rlsResponse.body);
          tableErrors.push({
            table: tableSpec.table_name,
            error: body.error?.message || body.message || 'Unknown error',
          });
        }
      }

      logFromRequest(request, {
        appId: resolvedApp.id,
        category: 'admin',
        eventType: 'app.secure',
        action: 'create',
        resourceType: 'app_config',
        resourceId: 'secure',
        eventData: {
          access_mode: 'authenticated',
          tables_secured: tablesSecured.length,
          table_errors: tableErrors.length,
        },
        success: true,
      });

      return reply.send({
        message: 'App secured successfully',
        app_id: resolvedApp.id,
        access_mode: 'authenticated',
        tables_secured: tablesSecured,
        ...(tableErrors.length > 0 && { table_errors: tableErrors }),
      });
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }
      app.log.error({ error }, 'Failed to secure app');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to secure app',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });
}
