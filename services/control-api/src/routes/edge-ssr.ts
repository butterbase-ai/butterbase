// Edge SSR deployment routes
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';
import {
  createAgentError,
  getDocUrl,
  detectInvalidInput,
  createInvalidInputError,
  detectConstraintViolation,
  createConstraintViolationError,
} from '../services/error-handler.js';
import { RESOURCE_NOT_FOUND, EXTERNAL_CLOUDFLARE_ERROR, EXTERNAL_DB_ERROR } from '@butterbase/shared/error-types';
import { requireUserId } from '../utils/require-auth.js';
import * as EdgeSsrDeploymentService from '../services/edge-ssr-deployment.service.js';
import { logFromRequest } from '../services/audit/with-audit.js';
import { config } from '../config.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';

const createDeploymentSchema = z.object({
  framework: z.enum(['nextjs-edge', 'remix-edge', 'other-edge']).optional(),
});

export async function registerEdgeSsrRoutes(fastify: FastifyInstance) {
  const { controlDb } = fastify;
  // Resolve the home region per-app: each request may target a different
  // region. The lookup is Redis-cached so it stays cheap.
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

  // Create deployment (Phase 1) — returns presigned R2 upload URL
  fastify.post('/v1/:appId/edge-ssr/deployments', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const body = createDeploymentSchema.parse(request.body);
    const userId = requireUserId(request);

    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);

    if (!config.cloudflare.enabled) {
      return reply.status(503).send(createAgentError({
        code: EXTERNAL_CLOUDFLARE_ERROR,
        message: 'Cloudflare Workers for Platforms is not configured',
        remediation: 'Contact the platform administrator to configure Cloudflare credentials.',
        documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR),
      }));
    }

    try {
      const result = await EdgeSsrDeploymentService.createDeployment(
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
        resourceId: result.id,
        eventData: { framework: body.framework },
        success: true,
      });

      return reply.send(result);
    } catch (error) {
      if (error instanceof EdgeSsrDeploymentService.DeploymentError) {
        // createDeployment only throws CREATE_FAILED for wrapped DB/R2 failures — not Cloudflare.
        return reply.status(500).send(createAgentError({
          code: EXTERNAL_DB_ERROR,
          message: error.message,
          remediation: 'Check your configuration and try again.',
          documentation_url: getDocUrl(EXTERNAL_DB_ERROR),
        }));
      }
      throw error;
    }
  });

  // Start deployment (Phase 2) — validates upload, kicks off background pipeline
  fastify.post('/v1/:appId/edge-ssr/deployments/:deploymentId/start', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, deploymentId } = request.params as { appId: string; deploymentId: string };
    const userId = requireUserId(request);

    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);

    try {
      const result = await EdgeSsrDeploymentService.startDeployment(
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
      if (error instanceof EdgeSsrDeploymentService.DeploymentError) {
        return reply.status(400).send(createAgentError({
          code: EXTERNAL_CLOUDFLARE_ERROR,
          message: error.message,
          remediation: 'Ensure the zip file was uploaded successfully and try again.',
          documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR),
        }));
      }
      throw error;
    }
  });

  // Sync deployment status — for SSR this re-reads the DB row (no external CF poll needed)
  fastify.post('/v1/:appId/edge-ssr/deployments/:deploymentId/sync', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, deploymentId } = request.params as { appId: string; deploymentId: string };
    const userId = requireUserId(request);

    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);

    try {
      const result = await EdgeSsrDeploymentService.syncDeploymentStatus(
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
        eventData: { status: result.status },
        success: true,
      });

      return reply.send(result);
    } catch (error) {
      if (error instanceof EdgeSsrDeploymentService.DeploymentError) {
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
        const status = error.code === 'NOT_FOUND' ? 404 : 400;
        const code = error.code === 'NOT_FOUND' ? RESOURCE_NOT_FOUND : EXTERNAL_CLOUDFLARE_ERROR;
        return reply.status(status).send(createAgentError({
          code,
          message: error.message,
          remediation: 'Check the deployment exists and try again.',
          documentation_url: getDocUrl(code),
        }));
      }
      throw error;
    }
  });

  // Cancel deployment
  fastify.post('/v1/:appId/edge-ssr/deployments/:deploymentId/cancel', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, deploymentId } = request.params as { appId: string; deploymentId: string };
    const userId = requireUserId(request);

    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);

    try {
      const result = await EdgeSsrDeploymentService.cancelDeployment(
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
      if (error instanceof EdgeSsrDeploymentService.DeploymentError) {
        const status = error.code === 'NOT_FOUND' ? 404 : 400;
        const code = error.code === 'NOT_FOUND' ? RESOURCE_NOT_FOUND : EXTERNAL_CLOUDFLARE_ERROR;
        return reply.status(status).send(createAgentError({
          code,
          message: error.message,
          remediation: 'Check the deployment status and try again.',
          documentation_url: getDocUrl(code),
        }));
      }
      throw error;
    }
  });

  // List deployments
  fastify.get('/v1/:appId/edge-ssr/deployments', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params as { appId: string };

    await AppResolver.resolveApp(controlDb, appId, requireUserId(request), request.auth?.organizationId ?? null);

    const result = await (await runtimeDb(appId)).query(
      `SELECT
        id, framework, deployment_url, status, error_message,
        file_count, total_size_bytes,
        worker_script_size_bytes, worker_script_module_count,
        created_at, started_at, completed_at, updated_at
       FROM app_edge_ssr_deployments
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
      workerScriptSizeBytes: row.worker_script_size_bytes ? parseInt(row.worker_script_size_bytes) : null,
      workerScriptModuleCount: row.worker_script_module_count ? parseInt(row.worker_script_module_count) : null,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
    }));

    return reply.send({ deployments });
  });

  // Get single deployment
  fastify.get('/v1/:appId/edge-ssr/deployments/:deploymentId', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, deploymentId } = request.params as { appId: string; deploymentId: string };

    await AppResolver.resolveApp(controlDb, appId, requireUserId(request), request.auth?.organizationId ?? null);

    const result = await (await runtimeDb(appId)).query(
      `SELECT * FROM app_edge_ssr_deployments WHERE id = $1 AND app_id = $2`,
      [deploymentId, appId]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Deployment not found',
        remediation: 'Verify the deployment ID is correct. Use list_edge_ssr_deployments to see available deployments.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }

    const row = result.rows[0];

    // For SSR, BUILDING means the WfP push is in-process in the same background
    // task — there is no external state to poll. Return the DB row as-is.

    return reply.send({
      id: row.id,
      framework: row.framework,
      url: row.deployment_url,
      status: row.status,
      error: row.error_message,
      fileCount: row.file_count,
      totalSizeBytes: row.total_size_bytes ? parseInt(row.total_size_bytes) : null,
      workerScriptSizeBytes: row.worker_script_size_bytes ? parseInt(row.worker_script_size_bytes) : null,
      workerScriptModuleCount: row.worker_script_module_count ? parseInt(row.worker_script_module_count) : null,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
    });
  });

  // Delete deployment
  fastify.delete('/v1/:appId/edge-ssr/deployments/:deploymentId', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, deploymentId } = request.params as { appId: string; deploymentId: string };
    const userId = requireUserId(request);

    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);

    try {
      await EdgeSsrDeploymentService.deleteDeployment(controlDb, appId, deploymentId);

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
      if (error instanceof EdgeSsrDeploymentService.DeploymentError) {
        const status = error.code === 'NOT_FOUND' ? 404 : 400;
        const code = error.code === 'NOT_FOUND' ? RESOURCE_NOT_FOUND : EXTERNAL_CLOUDFLARE_ERROR;
        return reply.status(status).send(createAgentError({
          code,
          message: error.message,
          remediation: 'Verify the deployment ID is correct.',
          documentation_url: getDocUrl(code),
        }));
      }
      throw error;
    }
  });
}
