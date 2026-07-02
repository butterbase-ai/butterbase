// services/control-api/src/routes/storage.ts
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { generatePresignedUploadUrl, generatePresignedDownloadUrl, deleteObject, S3Error } from '../services/s3.js';
import { checkStorageQuota, StorageQuotaError } from '../services/storage-quota.js';
import { verifyEndUserJwt } from '../services/end-user-auth.js';
import type { EndUserClaims } from '@butterbase/shared/types';
import { config } from '../config.js';
import { resolveAppHomeRegion } from '../services/region-resolver.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { createAgentError, getDocUrl, agentErrorFromEndUserJwtVerification } from '../services/error-handler.js';
import { incrementUsage } from '../services/usage-metering.js';
import { resolveOrganizationId } from '../services/org-resolver.js';
import { logFromRequest } from '../services/audit/with-audit.js';
import { AppPausedError, AppNotFoundError, AppResolver } from '../services/app-resolver.js';
import { resolveOrgFromApp } from '../services/app-org-resolver.js';
import { APP_PAUSED } from '@butterbase/shared/error-types';

const uploadRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  public: z.boolean().optional().default(false),
});

/**
 * Resolves app and user based on auth method
 */
async function resolveAppAndUser(
  controlDb: Pool,
  runtimeDb: Pool,
  appId: string,
  auth: any
): Promise<{ appExists: boolean; userId: string; storageConfig?: any }> {
  if (auth.authMethod === 'end_user_jwt') {
    // Verify JWT (looks up app_signing_keys in the app's home runtime DB)
    const endUserClaims = await verifyEndUserJwt(controlDb, appId, auth.rawToken!);

    // Verify app exists and fetch storage_config — apps is a runtime table
    const appResult = await runtimeDb.query(
      `SELECT id, storage_config, paused, paused_reason FROM apps WHERE id = $1`,
      [appId]
    );

    if (appResult.rows[0]?.paused) {
      throw new AppPausedError(appId, appResult.rows[0].paused_reason ?? null);
    }

    return {
      appExists: appResult.rows.length > 0,
      userId: endUserClaims.sub,
      storageConfig: appResult.rows[0]?.storage_config,
    };
  } else {
    // Platform auth — use org-aware AppResolver
    try {
      const resolved = await AppResolver.resolveApp(controlDb, appId, auth.userId);
      if (resolved.paused) {
        throw new AppPausedError(appId, resolved.paused_reason ?? null);
      }
      return { appExists: true, userId: auth.userId };
    } catch (err) {
      if (err instanceof AppNotFoundError) {
        return { appExists: false, userId: auth.userId };
      }
      throw err;
    }
  }
}

function pausedReply(reply: any, error: AppPausedError) {
  return reply.code(503)
    .header('Retry-After', '60')
    .send(createAgentError({
      code: APP_PAUSED,
      message: 'App is paused',
      remediation: error.reason
        ? `The app owner paused this app: "${error.reason}". Wait for it to be resumed, or contact the owner.`
        : 'The app owner paused this app. Wait for it to be resumed, or contact the owner.',
      documentation_url: getDocUrl(APP_PAUSED),
      details: { paused_reason: error.reason },
    }));
}

export async function storageRoutes(app: FastifyInstance) {
  // POST /storage/:appId/upload - Generate presigned upload URL
  app.post<{
    Params: { appId: string };
    Body: z.infer<typeof uploadRequestSchema>;
  }>('/storage/:appId/upload', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params;

    // Validate request body with safeParse
    const parseResult = uploadRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send(createAgentError({
        code: 'VALIDATION_INVALID_SCHEMA',
        message: 'Invalid upload request',
        remediation: 'Provide filename (string), contentType (string), and sizeBytes (positive integer).',
        documentation_url: getDocUrl('VALIDATION_INVALID_SCHEMA'),
        details: { validation_errors: parseResult.error.errors }
      }));
    }
    const body = parseResult.data;

    try {
      // Resolve app and user based on auth method
      const region = await resolveAppHomeRegion(app.controlDb, appId);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      const { appExists, userId } = await resolveAppAndUser(
        app.controlDb,
        runtimeDb,
        appId,
        request.auth
      );

      if (!appExists) {
        return reply.status(404).send(createAgentError({
          code: 'APP_NOT_FOUND',
          message: `App "${appId}" not found`,
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl('APP_NOT_FOUND')
        }));
      }

      // FIXME(batch-9.7): checkStorageQuota takes Pool and queries apps/storage_objects (runtime) — migrate service signature
      const quotaCheck = await checkStorageQuota(
        app.controlDb,
        appId,
        body.sizeBytes,
        body.contentType
      );

      if (!quotaCheck.allowed) {
        // Distinguish per-file-size, content-type, and total-quota rejections —
        // they have different status codes, error codes, and remediation text.
        // Conflating them produced "Current usage: undefined bytes" messages
        // when the per-file-size branch fired (no usage/limit populated).
        if (quotaCheck.kind === 'file_size') {
          return reply.status(400).send(createAgentError({
            code: 'QUOTA_FILE_SIZE_EXCEEDED',
            message: 'File exceeds the per-file size limit',
            remediation:
              `${quotaCheck.reason}. Either upload a smaller file, ` +
              `or raise "Max file size (MB)" in App Settings → Storage.`,
            documentation_url: getDocUrl('QUOTA_FILE_SIZE_EXCEEDED'),
            details: {
              file_size_bytes: quotaCheck.fileSizeBytes,
              max_file_size_bytes: quotaCheck.maxFileSizeBytes,
              reason: quotaCheck.reason,
            },
          }));
        }
        if (quotaCheck.kind === 'content_type') {
          return reply.status(400).send(createAgentError({
            code: 'VALIDATION_INVALID_TYPE',
            message: 'Content type not allowed for this app',
            remediation:
              `${quotaCheck.reason}. Update "allowedContentTypes" in the app's ` +
              `storage_config to permit this MIME type, or upload a different file.`,
            documentation_url: getDocUrl('VALIDATION_INVALID_TYPE'),
            details: {
              content_type: quotaCheck.contentType,
              reason: quotaCheck.reason,
            },
          }));
        }
        if (quotaCheck.kind === 'app_not_found') {
          return reply.status(404).send(createAgentError({
            code: 'APP_NOT_FOUND',
            message: `App "${appId}" not found`,
            remediation: 'Verify the app_id is correct.',
            documentation_url: getDocUrl('APP_NOT_FOUND'),
          }));
        }
        // Default: total-storage quota or transient usage-lookup failure.
        return reply.status(429).send(createAgentError({
          code: 'QUOTA_STORAGE_EXCEEDED',
          message: 'Storage quota exceeded',
          remediation:
            typeof quotaCheck.currentUsageBytes === 'number' &&
            typeof quotaCheck.limitBytes === 'number'
              ? `Current usage: ${quotaCheck.currentUsageBytes} bytes, Limit: ${quotaCheck.limitBytes} bytes. ` +
                `Upgrade your plan or delete unused files.`
              : `${quotaCheck.reason ?? 'Storage quota exceeded'}. Upgrade your plan or delete unused files.`,
          documentation_url: getDocUrl('QUOTA_STORAGE_EXCEEDED'),
          details: {
            current_usage_bytes: quotaCheck.currentUsageBytes,
            limit_bytes: quotaCheck.limitBytes,
            reason: quotaCheck.reason,
          },
        }));
      }

      // Generate presigned URL
      const result = await generatePresignedUploadUrl(
        appId,
        userId,
        body.filename,
        body.contentType,
        body.sizeBytes
      );

      // Platform/service auth: user_id is a platform user (not in app_users), so store NULL
      const storageUserId = request.auth.authMethod === 'end_user_jwt' ? userId : null;

      // Resolve organization_id for this app
      const organizationId = await resolveOrgFromApp(runtimeDb, appId);

      // Create database record immediately
      const dbResult = await runtimeDb.query(
        `INSERT INTO storage_objects (app_id, organization_id, user_id, bucket, key, filename, content_type, size_bytes, public)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [appId, organizationId, storageUserId, config.s3.bucket, result.objectKey, body.filename, body.contentType, body.sizeBytes, body.public]
      );

      // Calculate storage quota info
      const storageStats = await runtimeDb.query(
        `SELECT COUNT(*) as file_count, COALESCE(SUM(size_bytes), 0) as total_bytes
         FROM storage_objects
         WHERE app_id = $1`,
        [appId]
      );
      const storageUsedBytes = Number(storageStats.rows[0].total_bytes);
      const filesCount = Number(storageStats.rows[0].file_count);
      const storageLimitBytes = quotaCheck.limitBytes ?? 1024 * 1024 * 1024; // Default 1GB
      const storageUsedPercent = Math.round((storageUsedBytes / storageLimitBytes) * 100);

      logFromRequest(request, {
        appId,
        category: 'admin',
        eventType: 'storage.upload',
        action: 'create',
        resourceType: 'storage_object',
        resourceId: dbResult.rows[0].id,
        eventData: {
          filename: body.filename,
          content_type: body.contentType,
          size_bytes: body.sizeBytes,
          public: body.public,
          key: result.objectKey,
        },
        success: true,
      });

      return reply.send({
        ...result,
        objectId: dbResult.rows[0].id,
        _meta: {
          resource_info: {
            storage_used_bytes: storageUsedBytes,
            storage_limit_bytes: storageLimitBytes,
            storage_used_percent: storageUsedPercent,
            files_count: filesCount
          }
        }
      });
    } catch (error) {
      if (error instanceof AppPausedError) {
        return pausedReply(reply, error);
      }
      if (error instanceof StorageQuotaError) {
        return reply.status(400).send(createAgentError({
          code: 'QUOTA_STORAGE_ERROR',
          message: error.message,
          remediation: 'Check your storage quota and file size limits.',
          documentation_url: getDocUrl('QUOTA_STORAGE_ERROR'),
          details: { code: error.code }
        }));
      }
      if (error instanceof S3Error) {
        return reply.status(503).send(createAgentError({
          code: 'S3_ERROR',
          message: `S3 operation failed: ${error.message}`,
          remediation: 'This is a temporary issue with the storage service. Try again in a few moments.',
          documentation_url: getDocUrl('S3_ERROR'),
          details: { code: error.code }
        }));
      }
      // Check for FK constraint violations (e.g., user_id not found)
      if (error instanceof Error && error.message.includes('foreign key constraint')) {
        if (error.message.includes('user_id')) {
          return reply.status(403).send(createAgentError({
            code: 'AUTH_RLS_REQUIRES_USER_JWT',
            message: 'Storage operations require end-user authentication',
            remediation: 'Use an end-user JWT token instead of an API key. Storage objects must be associated with an authenticated user.',
            documentation_url: getDocUrl('AUTH_RLS_REQUIRES_USER_JWT')
          }));
        }
        return reply.status(400).send(createAgentError({
          code: 'VALIDATION_CONSTRAINT_VIOLATION',
          message: 'Database constraint violation',
          remediation: 'Check that all required references exist before creating the storage object.',
          documentation_url: getDocUrl('VALIDATION_CONSTRAINT_VIOLATION')
        }));
      }
      const endUserJwtErr = agentErrorFromEndUserJwtVerification(error);
      if (endUserJwtErr) {
        return reply.status(401).send(endUserJwtErr);
      }
      return reply.status(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: 'Storage upload failed',
        remediation: 'This is a temporary issue. Try again in a few moments.',
        documentation_url: getDocUrl('INTERNAL_ERROR')
      }));
    }
  });

  // GET /storage/:appId/objects - List storage objects
  app.get<{
    Params: { appId: string };
  }>('/storage/:appId/objects', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params;

    try {
      // Resolve app and user based on auth method
      const region = await resolveAppHomeRegion(app.controlDb, appId);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      const { appExists, userId } = await resolveAppAndUser(
        app.controlDb,
        runtimeDb,
        appId,
        request.auth
      );

      if (!appExists) {
        return reply.status(404).send(createAgentError({
          code: 'APP_NOT_FOUND',
          message: `App "${appId}" not found`,
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl('APP_NOT_FOUND')
        }));
      }

      // Platform auth (dashboard) sees all objects; end users see only their own
      const isPlatformAuth = request.auth.authMethod !== 'end_user_jwt';
      const result = isPlatformAuth
        ? await runtimeDb.query(
            `SELECT id, user_id, key, filename, content_type, size_bytes, created_at
             FROM storage_objects
             WHERE app_id = $1
             ORDER BY created_at DESC
             LIMIT 100`,
            [appId]
          )
        : await runtimeDb.query(
            `SELECT id, user_id, key, filename, content_type, size_bytes, created_at
             FROM storage_objects
             WHERE app_id = $1 AND user_id = $2
             ORDER BY created_at DESC
             LIMIT 100`,
            [appId, userId]
          );

      return reply.send({ objects: result.rows });
    } catch (error) {
      if (error instanceof AppPausedError) {
        return pausedReply(reply, error);
      }
      const endUserJwtErr = agentErrorFromEndUserJwtVerification(error);
      if (endUserJwtErr) {
        return reply.status(401).send(endUserJwtErr);
      }
      return reply.status(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to list storage objects',
        remediation: 'This is a temporary issue. Try again in a few moments.',
        documentation_url: getDocUrl('INTERNAL_ERROR')
      }));
    }
  });

  // GET /storage/:appId/download/:objectId - Generate presigned download URL
  app.get<{
    Params: { appId: string; objectId: string };
  }>('/storage/:appId/download/:objectId', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, objectId } = request.params;

    try {
      // Resolve app and user based on auth method
      const region = await resolveAppHomeRegion(app.controlDb, appId);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      const { appExists, userId, storageConfig } = await resolveAppAndUser(
        app.controlDb,
        runtimeDb,
        appId,
        request.auth
      );

      if (!appExists) {
        return reply.status(404).send(createAgentError({
          code: 'APP_NOT_FOUND',
          message: `App "${appId}" not found`,
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl('APP_NOT_FOUND')
        }));
      }

      // Always fetch the object without user_id filter, then check authorization
      const result = await runtimeDb.query(
        `SELECT key, filename, size_bytes, user_id, public
         FROM storage_objects
         WHERE id = $1 AND app_id = $2`,
        [objectId, appId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send(createAgentError({
          code: 'RESOURCE_NOT_FOUND',
          message: 'Storage object not found',
          remediation: 'Verify the object_id is correct. Use get_storage_objects to list available files.',
          documentation_url: getDocUrl('RESOURCE_NOT_FOUND')
        }));
      }

      const obj = result.rows[0];
      const isPlatformAuth = request.auth.authMethod !== 'end_user_jwt';
      const isAuthorized =
        isPlatformAuth ||
        storageConfig?.publicReadEnabled === true ||
        obj.public === true ||
        obj.user_id === userId;

      if (!isAuthorized) {
        // Return 404 (not 403) to avoid leaking object existence
        return reply.status(404).send(createAgentError({
          code: 'RESOURCE_NOT_FOUND',
          message: 'Storage object not found',
          remediation: 'Verify the object_id is correct. Use get_storage_objects to list available files.',
          documentation_url: getDocUrl('RESOURCE_NOT_FOUND')
        }));
      }

      const downloadUrl = await generatePresignedDownloadUrl(obj.key);

      // Track bandwidth usage for billing
      if (obj.size_bytes) {
        const dlOwnerResult = await runtimeDb.query(
          'SELECT owner_id FROM apps WHERE id = $1',
          [appId]
        );
        if (dlOwnerResult.rows.length > 0) {
          const ownerId = dlOwnerResult.rows[0].owner_id;
          void (async () => {
            const organizationId = await resolveOrganizationId(app.controlDb, ownerId);
            await incrementUsage(organizationId, ownerId, 'bandwidth_bytes', Number(obj.size_bytes), appId);
          })();
        }
      }

      return reply.send({
        downloadUrl,
        filename: obj.filename,
        expiresIn: 3600,
      });
    } catch (error) {
      if (error instanceof AppPausedError) {
        return pausedReply(reply, error);
      }
      if (error instanceof S3Error) {
        return reply.status(503).send(createAgentError({
          code: 'S3_ERROR',
          message: `S3 operation failed: ${error.message}`,
          remediation: 'This is a temporary issue with the storage service. Try again in a few moments.',
          documentation_url: getDocUrl('S3_ERROR'),
          details: { code: error.code }
        }));
      }
      const endUserJwtErr = agentErrorFromEndUserJwtVerification(error);
      if (endUserJwtErr) {
        return reply.status(401).send(endUserJwtErr);
      }
      return reply.status(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate download URL',
        remediation: 'This is a temporary issue. Try again in a few moments.',
        documentation_url: getDocUrl('INTERNAL_ERROR')
      }));
    }
  });

  // DELETE /storage/:appId/:objectId - Delete storage object
  app.delete<{
    Params: { appId: string; objectId: string };
  }>('/storage/:appId/:objectId', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, objectId } = request.params;

    try {
      // Resolve app and user based on auth method
      const region = await resolveAppHomeRegion(app.controlDb, appId);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      const { appExists, userId } = await resolveAppAndUser(
        app.controlDb,
        runtimeDb,
        appId,
        request.auth
      );

      if (!appExists) {
        return reply.status(404).send(createAgentError({
          code: 'APP_NOT_FOUND',
          message: `App "${appId}" not found`,
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl('APP_NOT_FOUND')
        }));
      }

      // Platform auth (dashboard) can delete any object; end users only their own
      const isPlatformAuth = request.auth.authMethod !== 'end_user_jwt';
      const result = isPlatformAuth
        ? await runtimeDb.query(
            `SELECT key
             FROM storage_objects
             WHERE id = $1 AND app_id = $2`,
            [objectId, appId]
          )
        : await runtimeDb.query(
            `SELECT key
             FROM storage_objects
             WHERE id = $1 AND app_id = $2 AND user_id = $3`,
            [objectId, appId, userId]
          );

      if (result.rows.length === 0) {
        return reply.status(404).send(createAgentError({
          code: 'RESOURCE_NOT_FOUND',
          message: 'Storage object not found',
          remediation: 'Verify the object_id is correct. Use get_storage_objects to list available files.',
          documentation_url: getDocUrl('RESOURCE_NOT_FOUND')
        }));
      }

      // Delete from S3
      await deleteObject(result.rows[0].key);

      // Delete from database
      await runtimeDb.query(
        'DELETE FROM storage_objects WHERE id = $1',
        [objectId]
      );

      logFromRequest(request, {
        appId,
        category: 'admin',
        eventType: 'storage.delete',
        action: 'delete',
        resourceType: 'storage_object',
        resourceId: objectId,
        eventData: { key: result.rows[0].key },
        success: true,
      });

      return reply.status(204).send();
    } catch (error) {
      if (error instanceof AppPausedError) {
        return pausedReply(reply, error);
      }
      if (error instanceof S3Error) {
        return reply.status(503).send(createAgentError({
          code: 'S3_ERROR',
          message: `S3 operation failed: ${error.message}`,
          remediation: 'This is a temporary issue with the storage service. Try again in a few moments.',
          documentation_url: getDocUrl('S3_ERROR'),
          details: { code: error.code }
        }));
      }
      const endUserJwtErr = agentErrorFromEndUserJwtVerification(error);
      if (endUserJwtErr) {
        return reply.status(401).send(endUserJwtErr);
      }
      return reply.status(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete storage object',
        remediation: 'This is a temporary issue. Try again in a few moments.',
        documentation_url: getDocUrl('INTERNAL_ERROR')
      }));
    }
  });
}

