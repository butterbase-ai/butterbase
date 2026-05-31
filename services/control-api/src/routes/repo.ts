import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authorizeRepoWrite } from '../services/repo-auth.js';
import { AppNotFoundError, AppPausedError } from '../services/app-resolver.js';
import {
  validateManifest,
  blobsReferenced,
  RepoManifestError,
} from '../services/repo-manifest.js';
import {
  headBlobs,
  presignBlobPut,
} from '../services/repo-storage.js';
import { requireUserId } from '../utils/require-auth.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import {
  VALIDATION_INVALID_SCHEMA,
  RESOURCE_NOT_FOUND,
  EXTERNAL_DB_ERROR,
  APP_PAUSED,
} from '@butterbase/shared/error-types';
import { logFromRequest } from '../services/audit/with-audit.js';
import type { AuditResourceType } from '../services/audit/types.js';

export async function repoRoutes(app: FastifyInstance) {
  // POST /v1/:app_id/repo/snapshots/prepare
  app.post('/v1/:app_id/repo/snapshots/prepare', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    try {
      const ctx = await authorizeRepoWrite(app.controlDb, app_id, requireUserId(request));

      let manifest;
      try {
        manifest = validateManifest(request.body);
      } catch (e) {
        if (e instanceof RepoManifestError) {
          const status = e.code === 'repo_too_large' || e.code === 'repo_file_too_large' ? 413 : 400;
          return reply.code(status).send(createAgentError({
            code: VALIDATION_INVALID_SCHEMA,
            message: e.message,
            remediation: 'Fix the manifest and retry. Repo cap is 100 MB total, 10 MB per file. Paths must be relative, ASCII-safe, no traversal.',
            documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
            details: { code: e.code, ...(e.details !== null && typeof e.details === 'object' ? e.details as Record<string, unknown> : {}) },
          }));
        }
        throw e;
      }

      const distinct = [...blobsReferenced(manifest.files)];
      const heads = await headBlobs(ctx.appId, distinct);
      const missing: { sha256: string; uploadUrl: string }[] = [];
      for (const sha of distinct) {
        if (!heads.get(sha)?.exists) {
          missing.push({ sha256: sha, uploadUrl: await presignBlobPut(ctx.appId, sha) });
        }
      }

      logFromRequest(request, {
        appId: ctx.appId,
        category: 'admin',
        eventType: 'app.repo.prepare',
        action: 'create',
        resourceType: 'app_repo' as AuditResourceType,
        resourceId: manifest.snapshotId,
        eventData: {
          snapshot_id: manifest.snapshotId,
          total_bytes: manifest.totalBytes,
          file_count: manifest.files.length,
          missing_blob_count: missing.length,
        },
        success: true,
      });

      return reply.send({
        snapshot_id: manifest.snapshotId,
        total_bytes: manifest.totalBytes,
        file_count: manifest.files.length,
        missing_blobs: missing,
      });
    } catch (error) {
      return handleRepoRouteError(app, request, reply, error, 'Failed to prepare repo snapshot');
    }
  });
}

function handleRepoRouteError(
  app: FastifyInstance,
  _request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  generic: string,
) {
  if (error instanceof AppNotFoundError) {
    return reply.code(404).send(createAgentError({
      code: RESOURCE_NOT_FOUND,
      message: 'App not found',
      remediation: 'Verify the app_id is correct and that you own it.',
      documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
    }));
  }
  if (error instanceof AppPausedError) {
    return reply.code(503).send(createAgentError({
      code: APP_PAUSED,
      message: 'App is paused',
      remediation: 'Resume the app before pushing.',
      documentation_url: getDocUrl(APP_PAUSED),
    }));
  }
  app.log.error({ err: error }, generic);
  return reply.code(500).send(createAgentError({
    code: EXTERNAL_DB_ERROR,
    message: generic,
    remediation: 'Retry. If the problem persists, check storage and database connectivity.',
    documentation_url: getDocUrl(EXTERNAL_DB_ERROR),
  }));
}
