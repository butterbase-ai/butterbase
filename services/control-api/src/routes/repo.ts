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
  putManifest,
  setLatest,
  listSnapshots,
  getManifestJson,
  deleteSnapshot,
  deleteBlob,
} from '../services/repo-storage.js';
import { planRetention } from '../services/repo-retention.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { config } from '../config.js';
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

  // POST /v1/:app_id/repo/snapshots/commit
  app.post('/v1/:app_id/repo/snapshots/commit', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    try {
      const ctx = await authorizeRepoWrite(app.controlDb, app_id, requireUserId(request));

      const manifest = validateManifest((request.body as any)?.manifest);

      const distinct = [...blobsReferenced(manifest.files)];
      const heads = await headBlobs(ctx.appId, distinct);

      const expectedSize = new Map<string, number>();
      for (const f of manifest.files) {
        const prev = expectedSize.get(f.sha256);
        if (prev !== undefined && prev !== f.size) {
          return reply.code(400).send(createAgentError({
            code: VALIDATION_INVALID_SCHEMA,
            message: `Manifest declares different sizes for the same sha256 ${f.sha256}`,
            remediation: 'Two paths with the same content sha must declare the same size.',
            documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
          }));
        }
        expectedSize.set(f.sha256, f.size);
      }

      const missing: string[] = [];
      const sizeMismatch: { sha256: string; expected: number; actual: number }[] = [];
      for (const sha of distinct) {
        const h = heads.get(sha);
        if (!h?.exists) { missing.push(sha); continue; }
        const want = expectedSize.get(sha) ?? -1;
        if (typeof h.size === 'number' && h.size !== want) {
          sizeMismatch.push({ sha256: sha, expected: want, actual: h.size });
        }
      }
      if (missing.length > 0 || sizeMismatch.length > 0) {
        return reply.code(409).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: 'Commit blocked: some blobs are missing or have unexpected sizes',
          remediation: 'Retry the upload for the listed shas, then re-call commit.',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
          details: { missing_shas: missing, size_mismatches: sizeMismatch },
        }));
      }

      await putManifest(ctx.appId, manifest.snapshotId, manifest.canonicalJson);
      await setLatest(ctx.appId, manifest.snapshotId);

      const runtimeDb = getRuntimeDbPool(config.runtimeDb, ctx.region);
      await runtimeDb.query(
        `UPDATE apps SET repo_latest_snapshot = $1, updated_at = now() WHERE id = $2`,
        [manifest.snapshotId, ctx.appId],
      );

      const all = await listSnapshots(ctx.appId);
      const summaries = await Promise.all(all.map(async s => {
        const json = await getManifestJson(ctx.appId, s.snapshotId);
        const m = json ? (JSON.parse(json) as { files: { sha256: string }[] }) : { files: [] };
        return {
          snapshotId: s.snapshotId,
          createdAt: s.lastModified,
          blobs: new Set(m.files.map(f => f.sha256)),
        };
      }));
      const plan = planRetention(summaries, new Set([manifest.snapshotId]));
      for (const snap of plan.dropSnapshots) {
        await deleteSnapshot(ctx.appId, snap);
      }
      for (const sha of plan.orphanBlobs) {
        await deleteBlob(ctx.appId, sha);
      }

      logFromRequest(request, {
        appId: ctx.appId,
        category: 'admin',
        eventType: 'app.repo.commit',
        action: 'create',
        resourceType: 'app_repo' as AuditResourceType,
        resourceId: manifest.snapshotId,
        eventData: {
          snapshot_id: manifest.snapshotId,
          file_count: manifest.files.length,
          total_bytes: manifest.totalBytes,
          dropped_snapshots: plan.dropSnapshots.length,
          orphan_blobs_pruned: plan.orphanBlobs.size,
        },
        success: true,
      });

      return reply.send({
        snapshot_id: manifest.snapshotId,
        total_bytes: manifest.totalBytes,
        file_count: manifest.files.length,
      });
    } catch (error) {
      if (error instanceof RepoManifestError) {
        const status = error.code === 'repo_too_large' || error.code === 'repo_file_too_large' ? 413 : 400;
        return reply.code(status).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: error.message,
          remediation: 'Fix the manifest and retry.',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
          details: { code: error.code },
        }));
      }
      return handleRepoRouteError(app, request, reply, error, 'Failed to commit repo snapshot');
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
