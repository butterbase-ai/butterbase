// Frontend deployment routes
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';
import { encrypt } from '../services/crypto.js';
import {
  createAgentError,
  getDocUrl,
  detectInvalidInput,
  createInvalidInputError,
  detectConstraintViolation,
  createConstraintViolationError,
} from '../services/error-handler.js';
import { RESOURCE_NOT_FOUND, VALIDATION_INVALID_SCHEMA, EXTERNAL_CLOUDFLARE_ERROR, QUOTA_DEPLOYMENT_LIMIT } from '@butterbase/shared/error-types';
import { config } from '../config.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { requireUserId } from '../utils/require-auth.js';
import * as DeploymentService from '../services/deployment.service.js';
import { logFromRequest } from '../services/audit/with-audit.js';

const createDeploymentSchema = z.object({
  framework: z.enum(['react-vite', 'nextjs-static', 'static', 'other']).optional(),
});

const setFrontendEnvSchema = z.record(z.string());

export async function registerFrontendRoutes(fastify: FastifyInstance) {
  const { controlDb } = fastify;
  const runtimeDb = (appId: string) => getRuntimeDbForApp(controlDb, appId);

  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppNotFoundError) {
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'App not found',
        remediation: 'Verify the app_id is correct. Use list_apps to see available apps. If you just called init_app, the database may still be provisioning — wait a few seconds and retry.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }

    const invalidInput = detectInvalidInput(error);
    if (invalidInput.isInvalidInput) {
      return reply.code(400).send(createInvalidInputError(invalidInput.code!, invalidInput.detail));
    }

    const constraintCheck = detectConstraintViolation(error);
    if (constraintCheck.isConstraint) {
      return reply.code(400).send(
        createConstraintViolationError(constraintCheck.constraintType!, constraintCheck.details!, { column: constraintCheck.column, tableName: constraintCheck.tableName })
      );
    }

    throw error;
  });

  // Create deployment (Phase 1)
  fastify.post('/v1/:appId/frontend/deployments', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const body = createDeploymentSchema.parse(request.body);
    const userId = requireUserId(request);

    // Validate app ownership
    await AppResolver.resolveApp(controlDb, appId, userId);

    // Check if Cloudflare is enabled
    if (!config.cloudflare.enabled) {
      return reply.status(503).send(createAgentError({
        code: EXTERNAL_CLOUDFLARE_ERROR,
        message: 'Cloudflare Pages is not configured',
        remediation: 'Contact the platform administrator to configure Cloudflare Pages credentials.',
        documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR)
      }));
    }

    try {
      // FIXME(batch-9.7): DeploymentService.createDeployment takes Pool and queries app_deployments/apps (runtime) — migrate service signature
      const result = await DeploymentService.createDeployment(
        controlDb,
        appId,
        userId,
        body.framework
      );

      logFromRequest(request, {
        appId,
        category: 'admin',
        eventType: 'deployment.create',
        action: 'create',
        resourceType: 'deployment',
        resourceId: (result as any)?.deploymentId ?? (result as any)?.id,
        eventData: { framework: body.framework },
        success: true,
      });

      return reply.send(result);
    } catch (error) {
      if (error instanceof DeploymentService.DeploymentError) {
        return reply.status(500).send(createAgentError({
          code: EXTERNAL_CLOUDFLARE_ERROR,
          message: error.message,
          remediation: 'Check your configuration and try again.',
          documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR)
        }));
      }
      throw error;
    }
  });

  // Start deployment (Phase 2)
  fastify.post('/v1/:appId/frontend/deployments/:deploymentId/start', async (request, reply) => {
    const { appId, deploymentId } = request.params as { appId: string; deploymentId: string };
    const userId = requireUserId(request);

    // Validate app ownership
    await AppResolver.resolveApp(controlDb, appId, userId);

    try {
      const result = await DeploymentService.startDeployment(
        controlDb,
        appId,
        deploymentId,
        userId
      );

      logFromRequest(request, {
        appId,
        category: 'admin',
        eventType: 'deployment.start',
        action: 'update',
        resourceType: 'deployment',
        resourceId: deploymentId,
        success: true,
      });

      return reply.send(result);
    } catch (error) {
      if (error instanceof DeploymentService.DeploymentError) {
        return reply.status(400).send(createAgentError({
          code: EXTERNAL_CLOUDFLARE_ERROR,
          message: error.message,
          remediation: 'Ensure the zip file was uploaded successfully and try again.',
          documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR)
        }));
      }
      throw error;
    }
  });

  // Sync deployment status
  fastify.post('/v1/:appId/frontend/deployments/:deploymentId/sync', async (request, reply) => {
    const { appId, deploymentId } = request.params as { appId: string; deploymentId: string };
    const userId = requireUserId(request);

    await AppResolver.resolveApp(controlDb, appId, userId);

    try {
      const result = await DeploymentService.syncDeploymentStatus(
        controlDb,
        appId,
        deploymentId
      );

      logFromRequest(request, {
        appId,
        category: 'admin',
        eventType: 'deployment.sync',
        action: 'update',
        resourceType: 'deployment',
        resourceId: deploymentId,
        eventData: { status: (result as any)?.status },
        success: true,
      });

      return reply.send(result);
    } catch (error) {
      if (error instanceof DeploymentService.DeploymentError) {
        logFromRequest(request, {
          appId,
          category: 'admin',
          eventType: 'deployment.sync',
          action: 'update',
          resourceType: 'deployment',
          resourceId: deploymentId,
          success: false,
          errorMessage: error.message,
        });
        return reply.status(400).send(createAgentError({
          code: EXTERNAL_CLOUDFLARE_ERROR,
          message: error.message,
          remediation: 'Check the deployment exists and try again.',
          documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR)
        }));
      }
      throw error;
    }
  });

  // Cancel deployment
  fastify.post('/v1/:appId/frontend/deployments/:deploymentId/cancel', async (request, reply) => {
    const { appId, deploymentId } = request.params as { appId: string; deploymentId: string };
    const userId = requireUserId(request);

    await AppResolver.resolveApp(controlDb, appId, userId);

    try {
      const result = await DeploymentService.cancelDeployment(
        controlDb,
        appId,
        deploymentId
      );

      logFromRequest(request, {
        appId,
        category: 'admin',
        eventType: 'deployment.cancel',
        action: 'update',
        resourceType: 'deployment',
        resourceId: deploymentId,
        success: true,
      });

      return reply.send(result);
    } catch (error) {
      if (error instanceof DeploymentService.DeploymentError) {
        return reply.status(400).send(createAgentError({
          code: EXTERNAL_CLOUDFLARE_ERROR,
          message: error.message,
          remediation: 'Check the deployment status and try again.',
          documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR)
        }));
      }
      throw error;
    }
  });

  // List deployments
  fastify.get('/v1/:appId/frontend/deployments', async (request, reply) => {
    const { appId } = request.params as { appId: string };

    // Validate app ownership
    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

    const result = await (await runtimeDb(appId)).query(
      `SELECT
        id, framework, deployment_url, status, error_message,
        file_count, total_size_bytes, created_at, started_at, completed_at, updated_at
       FROM app_deployments
       WHERE app_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [appId]
    );

    const deployments = result.rows.map((row) => ({
      id: row.id,
      framework: row.framework,
      url: row.deployment_url,
      status: row.status,
      error: row.error_message,
      fileCount: row.file_count,
      totalSizeBytes: row.total_size_bytes ? parseInt(row.total_size_bytes) : null,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
    }));

    return reply.send({ deployments });
  });

  // Get single deployment
  fastify.get('/v1/:appId/frontend/deployments/:deploymentId', async (request, reply) => {
    const { appId, deploymentId } = request.params as { appId: string; deploymentId: string };

    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

    let result = await (await runtimeDb(appId)).query(
      `SELECT * FROM app_deployments WHERE id = $1 AND app_id = $2`,
      [deploymentId, appId]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Deployment not found',
        remediation: 'Verify the deployment ID is correct. Use list_frontend_deployments to see available deployments.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
      }));
    }

    let row = result.rows[0];

    // Auto-sync with Cloudflare when deployment is still building
    if (row.status === 'BUILDING' && row.cloudflare_deployment_id) {
      try {
        const synced = await DeploymentService.syncDeploymentStatus(controlDb, appId, deploymentId);
        if (synced.status !== row.status) {
          // Re-read to get the updated row
          result = await (await runtimeDb(appId)).query(
            `SELECT * FROM app_deployments WHERE id = $1 AND app_id = $2`,
            [deploymentId, appId]
          );
          row = result.rows[0];
        }
      } catch {
        // Sync failed — return stale status rather than erroring
      }
    }

    return reply.send({
      id: row.id,
      framework: row.framework,
      url: row.deployment_url,
      status: row.status,
      error: row.error_message,
      fileCount: row.file_count,
      totalSizeBytes: parseInt(row.total_size_bytes),
      cloudflareProjectName: row.cloudflare_project_name,
      cloudflareDeploymentId: row.cloudflare_deployment_id,
      buildConfig: row.build_config,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  });

  // Set frontend environment variables (PUT and PATCH both supported)
  const setFrontendEnvHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { appId } = request.params as { appId: string };
    const body = setFrontendEnvSchema.parse(request.body);

    // Validate app ownership
    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

    // Validate envVars
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Environment variables must be a non-empty object',
        remediation: 'Provide environment variables as key-value pairs. Example: {"VITE_API_URL": "https://api.example.com"}',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA)
      }));
    }

    // Upsert each environment variable
    for (const [key, value] of Object.entries(body)) {
      const encryptedValue = encrypt(value, process.env.AUTH_ENCRYPTION_KEY!);

      await (await runtimeDb(appId)).query(
        `INSERT INTO app_frontend_env_vars (app_id, key, encrypted_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (app_id, key)
         DO UPDATE SET encrypted_value = $3, updated_at = now()`,
        [appId, key, encryptedValue]
      );
    }

    // Mark any READY deployments for WfP-backed apps as having stale env vars.
    // We do NOT auto-redeploy — users must trigger a redeploy to pick up the changes.
    await (await runtimeDb(appId)).query(
      `UPDATE app_deployments
       SET env_vars_stale = true, updated_at = now()
       WHERE app_id = $1
         AND status = 'READY'
         AND EXISTS (SELECT 1 FROM apps WHERE id = $1 AND deployment_backend = 'wfp')`,
      [appId]
    );

    logFromRequest(request, {
      appId,
      category: 'admin',
      eventType: 'deployment.env.update',
      action: 'update',
      resourceType: 'deployment',
      eventData: { env_var_keys: Object.keys(body) },
      success: true,
    });

    return reply.send({
      message: 'Frontend environment variables updated successfully',
      keys: Object.keys(body),
    });
  };

  fastify.put('/v1/:appId/frontend/env', setFrontendEnvHandler);
  fastify.patch('/v1/:appId/frontend/env', setFrontendEnvHandler);

  // Get frontend environment variable keys (not values)
  fastify.get('/v1/:appId/frontend/env', async (request, reply) => {
    const { appId } = request.params as { appId: string };

    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));

    const result = await (await runtimeDb(appId)).query(
      `SELECT key, created_at, updated_at
       FROM app_frontend_env_vars
       WHERE app_id = $1
       ORDER BY key`,
      [appId]
    );

    const envVars = result.rows.map((row) => ({
      key: row.key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return reply.send({ envVars });
  });

  // Delete deployment
  fastify.delete('/v1/:appId/frontend/deployments/:deploymentId', async (request, reply) => {
    const { appId, deploymentId } = request.params as { appId: string; deploymentId: string };
    const userId = requireUserId(request);

    await AppResolver.resolveApp(controlDb, appId, userId);

    try {
      await DeploymentService.deleteDeployment(controlDb, appId, deploymentId);
      logFromRequest(request, {
        appId,
        category: 'admin',
        eventType: 'deployment.delete',
        action: 'delete',
        resourceType: 'deployment',
        resourceId: deploymentId,
        success: true,
      });
      return reply.send({ deleted: true });
    } catch (error) {
      if (error instanceof DeploymentService.DeploymentError) {
        const status = error.code === 'NOT_FOUND' ? 404 : 400;
        return reply.status(status).send(createAgentError({
          code: error.code === 'NOT_FOUND' ? RESOURCE_NOT_FOUND : EXTERNAL_CLOUDFLARE_ERROR,
          message: error.message,
          remediation: 'Verify the deployment ID is correct.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }
      throw error;
    }
  });
}
