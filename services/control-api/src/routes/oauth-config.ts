import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { encrypt, decrypt } from '../services/crypto.js';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';
import { config } from '../config.js';
import { resolveAppHomeRegion } from '../services/region-resolver.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { createAgentError, getDocUrl, isHttpError } from '../services/error-handler.js';
import { RESOURCE_NOT_FOUND, VALIDATION_INVALID_SCHEMA, EXTERNAL_DB_ERROR } from '@butterbase/shared/error-types';
import { requireUserId } from '../utils/require-auth.js';
import { getProviderDefinition } from '../services/auth/oauth-providers.js';
import { logFromRequest } from '../services/audit/with-audit.js';

const createOAuthConfigSchema = z.object({
  provider: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
  redirect_uris: z.array(z.string().url()).min(1),
  scopes: z.array(z.string()).optional(),
  authorization_url: z.string().url().optional(),
  token_url: z.string().url().optional(),
  userinfo_url: z.string().url().optional(),
  provider_metadata: z.record(z.unknown()).optional(),
});

const updateOAuthConfigSchema = z.object({
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  redirect_uris: z.array(z.string().url()).optional(),
  scopes: z.array(z.string()).optional(),
  authorization_url: z.string().url().optional(),
  token_url: z.string().url().optional(),
  userinfo_url: z.string().url().optional(),
  enabled: z.boolean().optional(),
  provider_metadata: z.record(z.unknown()).optional(),
});

export async function oauthConfigRoutes(app: FastifyInstance) {
  // CREATE/UPDATE OAUTH CONFIG — POST /v1/:app_id/auth/oauth-config
  app.post('/v1/:app_id/auth/oauth-config', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    // Validate request body
    const parseResult = createOAuthConfigSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Invalid request body',
        remediation: 'Review the validation errors in the details field and correct your OAuth configuration.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        details: parseResult.error.errors
      }));
    }

    const {
      provider,
      client_id,
      client_secret,
      redirect_uris,
      scopes: userScopes,
      authorization_url: userAuthUrl,
      token_url: userTokenUrl,
      userinfo_url: userUserinfoUrl,
      provider_metadata,
    } = parseResult.data;

    const region = await resolveAppHomeRegion(app.controlDb, app_id);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);

      // Auto-fill URLs and scopes from provider registry for known providers
      const providerDef = getProviderDefinition(provider);
      const authorization_url = userAuthUrl || providerDef?.authorizationUrl || null;
      const token_url = userTokenUrl || providerDef?.tokenUrl || null;
      const userinfo_url = userUserinfoUrl || providerDef?.userinfoUrl || null;
      const scopes = (userScopes && userScopes.length > 0) ? userScopes : (providerDef?.defaultScopes || []);

      // Encrypt client secret
      const encryptedSecret = encrypt(client_secret, config.auth.encryptionKey);

      // Upsert OAuth config — app_oauth_configs is a runtime table
      const result = await runtimeDb.query(
        `INSERT INTO app_oauth_configs (
          app_id, provider, client_id, client_secret_encrypted,
          redirect_uris, scopes, authorization_url, token_url, userinfo_url, provider_metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (app_id, provider)
        DO UPDATE SET
          client_id = $3,
          client_secret_encrypted = $4,
          redirect_uris = $5,
          scopes = $6,
          authorization_url = $7,
          token_url = $8,
          userinfo_url = $9,
          provider_metadata = $10
        RETURNING id, app_id, provider, client_id, redirect_uris, scopes, authorization_url, token_url, userinfo_url, enabled, provider_metadata`,
        [
          app_id,
          provider,
          client_id,
          encryptedSecret,
          redirect_uris,
          scopes,
          authorization_url,
          token_url,
          userinfo_url,
          JSON.stringify(provider_metadata || {}),
        ]
      );

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'oauth.provider.create',
        action: 'create',
        resourceType: 'oauth_provider',
        resourceId: provider,
        eventData: { provider, client_id },
        success: true,
      });

      return reply.send({
        message: 'OAuth configuration saved successfully',
        config: result.rows[0],
      });
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
      app.log.error({ error }, 'Failed to save OAuth config');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to save OAuth configuration',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });

  // LIST OAUTH CONFIGS — GET /v1/:app_id/auth/oauth-config
  app.get('/v1/:app_id/auth/oauth-config', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    const region = await resolveAppHomeRegion(app.controlDb, app_id);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);

      // app_oauth_configs is a runtime table
      const result = await runtimeDb.query(
        `SELECT id, app_id, provider, client_id, redirect_uris, scopes, authorization_url, token_url, userinfo_url, enabled, provider_metadata, created_at
         FROM app_oauth_configs
         WHERE app_id = $1
         ORDER BY provider`,
        [app_id]
      );

      return reply.send({ configs: result.rows });
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
      app.log.error({ error }, 'Failed to list OAuth configs');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to list OAuth configurations',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });

  // GET SINGLE OAUTH CONFIG — GET /v1/:app_id/auth/oauth-config/:provider
  app.get('/v1/:app_id/auth/oauth-config/:provider', async (request, reply) => {
    const { app_id, provider } = request.params as { app_id: string; provider: string };

    const region = await resolveAppHomeRegion(app.controlDb, app_id);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);

      // app_oauth_configs is a runtime table
      const result = await runtimeDb.query(
        `SELECT id, app_id, provider, client_id, redirect_uris, scopes, authorization_url, token_url, userinfo_url, enabled, provider_metadata, created_at
         FROM app_oauth_configs
         WHERE app_id = $1 AND provider = $2`,
        [app_id, provider]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: `OAuth configuration for provider "${provider}" not found`,
          remediation: 'Verify the provider name is correct. Use GET /v1/{app_id}/auth/oauth-config to list configured providers.',
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
      app.log.error({ error }, 'Failed to get OAuth config');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to get OAuth configuration',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });

  // UPDATE OAUTH CONFIG — PATCH /v1/:app_id/auth/oauth-config/:provider
  app.patch('/v1/:app_id/auth/oauth-config/:provider', async (request, reply) => {
    const { app_id, provider } = request.params as { app_id: string; provider: string };

    // Validate request body
    const parseResult = updateOAuthConfigSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Invalid request body',
        remediation: 'Review the validation errors in the details field and correct your OAuth configuration update.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        details: parseResult.error.errors
      }));
    }

    const updates = parseResult.data;

    const region = await resolveAppHomeRegion(app.controlDb, app_id);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);

      // Build dynamic update query
      const updateFields: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (updates.client_id !== undefined) {
        updateFields.push(`client_id = $${paramIndex++}`);
        values.push(updates.client_id);
      }

      if (updates.client_secret !== undefined) {
        const encryptedSecret = encrypt(updates.client_secret, config.auth.encryptionKey);
        updateFields.push(`client_secret_encrypted = $${paramIndex++}`);
        values.push(encryptedSecret);
      }

      if (updates.redirect_uris !== undefined) {
        updateFields.push(`redirect_uris = $${paramIndex++}`);
        values.push(updates.redirect_uris);
      }

      if (updates.scopes !== undefined) {
        updateFields.push(`scopes = $${paramIndex++}`);
        values.push(updates.scopes);
      }

      if (updates.authorization_url !== undefined) {
        updateFields.push(`authorization_url = $${paramIndex++}`);
        values.push(updates.authorization_url);
      }

      if (updates.token_url !== undefined) {
        updateFields.push(`token_url = $${paramIndex++}`);
        values.push(updates.token_url);
      }

      if (updates.userinfo_url !== undefined) {
        updateFields.push(`userinfo_url = $${paramIndex++}`);
        values.push(updates.userinfo_url);
      }

      if (updates.enabled !== undefined) {
        updateFields.push(`enabled = $${paramIndex++}`);
        values.push(updates.enabled);
      }

      if (updates.provider_metadata !== undefined) {
        updateFields.push(`provider_metadata = $${paramIndex++}`);
        values.push(JSON.stringify(updates.provider_metadata));
      }

      if (updateFields.length === 0) {
        return reply.code(400).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: 'No fields to update',
          remediation: 'Provide at least one field to update (client_id, client_secret, redirect_uris, scopes, authorization_url, token_url, userinfo_url, enabled, or provider_metadata).',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA)
        }));
      }

      values.push(app_id, provider);

      // app_oauth_configs is a runtime table
      const result = await runtimeDb.query(
        `UPDATE app_oauth_configs
         SET ${updateFields.join(', ')}
         WHERE app_id = $${paramIndex++} AND provider = $${paramIndex++}
         RETURNING id, app_id, provider, client_id, redirect_uris, scopes, authorization_url, token_url, userinfo_url, enabled, provider_metadata`,
        values
      );

      if (result.rows.length === 0) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: `OAuth configuration for provider "${provider}" not found`,
          remediation: 'Verify the provider name is correct. Use GET /v1/{app_id}/auth/oauth-config to list configured providers.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'oauth.provider.update',
        action: 'update',
        resourceType: 'oauth_provider',
        resourceId: provider,
        eventData: { provider, changed_fields: Object.keys(updates) },
        success: true,
      });

      return reply.send({
        message: 'OAuth configuration updated successfully',
        config: result.rows[0],
      });
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
      app.log.error({ error }, 'Failed to update OAuth config');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to update OAuth configuration',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });

  // DELETE OAUTH CONFIG — DELETE /v1/:app_id/auth/oauth-config/:provider
  app.delete('/v1/:app_id/auth/oauth-config/:provider', async (request, reply) => {
    const { app_id, provider } = request.params as { app_id: string; provider: string };

    const region = await resolveAppHomeRegion(app.controlDb, app_id);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);

      // app_oauth_configs is a runtime table
      const result = await runtimeDb.query(
        `DELETE FROM app_oauth_configs
         WHERE app_id = $1 AND provider = $2
         RETURNING provider`,
        [app_id, provider]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: `OAuth configuration for provider "${provider}" not found`,
          remediation: 'Verify the provider name is correct. Use GET /v1/{app_id}/auth/oauth-config to list configured providers.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'oauth.provider.delete',
        action: 'delete',
        resourceType: 'oauth_provider',
        resourceId: provider,
        eventData: { provider },
        success: true,
      });

      return reply.send({
        message: 'OAuth configuration deleted successfully',
        provider: result.rows[0].provider,
      });
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
      app.log.error({ error }, 'Failed to delete OAuth config');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to delete OAuth configuration',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });
}
