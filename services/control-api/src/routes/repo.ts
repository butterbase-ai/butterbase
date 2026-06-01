import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authorizeRepoWrite, authorizeRepoRead } from '../services/repo-auth.js';
import { AppNotFoundError, AppPausedError } from '../services/app-resolver.js';
import {
  validateManifest,
  blobsReferenced,
  RepoManifestError,
} from '../services/repo-manifest.js';
import {
  headBlobs,
  headBlob,
  presignBlobPut,
  presignBlobGet,
  putManifest,
  setLatest,
  listSnapshots,
  getManifestJson,
  getLatestSnapshotId,
  deleteSnapshot,
  deleteBlob,
  wipeRepo,
  sumRepoBlobBytes,
} from '../services/repo-storage.js';
import { planRetention } from '../services/repo-retention.js';
import { listActiveCloneSnapshotIdsForApp } from '../services/clone-jobs.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { config } from '../config.js';
import { requireUserId, tryGetUserId } from '../utils/require-auth.js';
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
  app.post('/v1/:app_id/repo/snapshots/prepare', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
        keyGenerator: (req) => {
          const { app_id } = req.params as { app_id: string };
          return `app:${app_id}:prepare`;
        },
      },
    },
  }, async (request, reply) => {
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

      // Check per-app total storage quota (storage_config.total_size_limit).
      const runtimeDbQuota = getRuntimeDbPool(config.runtimeDb, ctx.region);
      const cfgRes = await runtimeDbQuota.query<{ storage_config: { total_size_limit?: number } | null }>(
        `SELECT storage_config FROM apps WHERE id = $1`,
        [ctx.appId],
      );
      const totalSizeLimit = cfgRes.rows[0]?.storage_config?.total_size_limit;
      if (totalSizeLimit !== undefined && totalSizeLimit !== null) {
        const currentBytes = await sumRepoBlobBytes(ctx.appId);
        const manifestBytes = manifest.totalBytes;
        if (currentBytes + manifestBytes > totalSizeLimit) {
          return reply.code(413).send({
            error: 'storage_quota_exceeded',
            current_bytes: currentBytes,
            limit_bytes: totalSizeLimit,
            manifest_bytes: manifestBytes,
          });
        }
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
      const cloneActivePins = await listActiveCloneSnapshotIdsForApp(app.controlDb, ctx.appId);
      const pinned = new Set<string>([manifest.snapshotId, ...cloneActivePins]);
      const plan = planRetention(summaries, pinned);
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

  // GET /v1/:app_id/repo/snapshots/latest
  app.get('/v1/:app_id/repo/snapshots/latest', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    try {
      const userId = tryGetUserId(request);
      const ctx = await authorizeRepoRead(app.controlDb, app_id, userId);

      const latestId = await getLatestSnapshotId(ctx.appId);
      if (!latestId) return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'No snapshots have been pushed for this app',
        remediation: 'Push a snapshot via POST /v1/:app_id/repo/snapshots/prepare + commit.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));

      const json = await getManifestJson(ctx.appId, latestId);
      if (!json) return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: `latest pointer references missing manifest ${latestId}`,
        remediation: 'Push a new snapshot to overwrite the stale pointer.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));

      const manifest = JSON.parse(json);
      return reply.send({ snapshot_id: latestId, manifest });
    } catch (error) {
      return handleRepoRouteError(app, request, reply, error, 'Failed to load latest snapshot');
    }
  });

  // GET /v1/:app_id/repo/snapshots
  app.get('/v1/:app_id/repo/snapshots', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    try {
      const userId = tryGetUserId(request);
      const ctx = await authorizeRepoRead(app.controlDb, app_id, userId);

      const snapshots = await listSnapshots(ctx.appId);
      // Sort newest-first; this is what every consumer will want.
      snapshots.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

      return reply.send({
        snapshots: snapshots.map(s => ({
          snapshot_id: s.snapshotId,
          created_at: s.lastModified.toISOString(),
        })),
      });
    } catch (error) {
      return handleRepoRouteError(app, request, reply, error, 'Failed to list snapshots');
    }
  });

  // GET /v1/:app_id/repo/snapshots/:snapshot_id
  app.get('/v1/:app_id/repo/snapshots/:snapshot_id', async (request, reply) => {
    const { app_id, snapshot_id } = request.params as { app_id: string; snapshot_id: string };
    if (!/^[a-f0-9]{64}$/.test(snapshot_id)) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'snapshot_id must be a 64-char lowercase hex string',
        remediation: 'Use the snapshot_id returned by prepare/commit.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }
    try {
      const userId = tryGetUserId(request);
      const ctx = await authorizeRepoRead(app.controlDb, app_id, userId);

      const json = await getManifestJson(ctx.appId, snapshot_id);
      if (!json) return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: `Snapshot ${snapshot_id} not found`,
        remediation: 'Verify the snapshot_id or push a new snapshot.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));

      const manifest = JSON.parse(json);
      return reply.send({ snapshot_id, manifest });
    } catch (error) {
      return handleRepoRouteError(app, request, reply, error, 'Failed to load snapshot');
    }
  });

  // GET /v1/:app_id/repo/blobs/:sha256
  app.get('/v1/:app_id/repo/blobs/:sha256', async (request, reply) => {
    const { app_id, sha256 } = request.params as { app_id: string; sha256: string };
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'sha256 must be a 64-char lowercase hex string',
        remediation: 'Use a sha256 listed in a snapshot manifest.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }
    try {
      const userId = tryGetUserId(request);
      const ctx = await authorizeRepoRead(app.controlDb, app_id, userId);

      const head = await headBlob(ctx.appId, sha256);
      if (!head.exists) return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: `Blob ${sha256} not found in this app's repo`,
        remediation: 'The blob may have been pruned. Re-pull a current snapshot manifest first.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));

      const downloadUrl = await presignBlobGet(ctx.appId, sha256);
      return reply.send({ sha256, size: head.size, downloadUrl, expiresIn: 3600 });
    } catch (error) {
      return handleRepoRouteError(app, request, reply, error, 'Failed to load blob');
    }
  });

  // POST /v1/:app_id/repo/blobs/batch
  app.post('/v1/:app_id/repo/blobs/batch', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const body = request.body as { shas?: unknown } | null;
    const shas = Array.isArray(body?.shas) ? (body!.shas as unknown[]) : null;
    if (!shas || shas.length === 0) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Body must include a non-empty `shas` array.',
        remediation: 'Pass { shas: ["<sha256>", ...] } with at least one entry.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }
    if (shas.length > 1000) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Batch size exceeds 1000 shas.',
        remediation: 'Split the request into multiple calls of at most 1000 shas.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }
    for (const s of shas) {
      if (typeof s !== 'string' || !/^[a-f0-9]{64}$/.test(s)) {
        return reply.code(400).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: 'Each sha must be a 64-char lowercase hex string.',
          remediation: 'Use sha256 values from a snapshot manifest.',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        }));
      }
    }
    try {
      const userId = tryGetUserId(request);
      const ctx = await authorizeRepoRead(app.controlDb, app_id, userId);

      const heads = await headBlobs(ctx.appId, shas as string[]);
      const present = [...heads.entries()].filter(([, h]) => h.exists);
      const blobs = await Promise.all(present.map(async ([sha, h]) => ({
        sha256: sha,
        size: typeof h.size === 'number' ? h.size : 0,
        downloadUrl: await presignBlobGet(ctx.appId, sha),
        expiresIn: 3600,
      })));
      return reply.send({ blobs });
    } catch (error) {
      return handleRepoRouteError(app, request, reply, error, 'Failed to batch-presign blobs');
    }
  });

  // DELETE /v1/:app_id/repo
  app.delete('/v1/:app_id/repo', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    try {
      const ctx = await authorizeRepoWrite(app.controlDb, app_id, requireUserId(request));
      await wipeRepo(ctx.appId);

      const runtimeDb = getRuntimeDbPool(config.runtimeDb, ctx.region);
      await runtimeDb.query(
        `UPDATE apps SET repo_latest_snapshot = NULL, updated_at = now() WHERE id = $1`,
        [ctx.appId],
      );

      logFromRequest(request, {
        appId: ctx.appId,
        category: 'admin',
        eventType: 'app.repo.wipe',
        action: 'delete',
        resourceType: 'app_repo' as AuditResourceType,
        resourceId: 'repo',
        eventData: {},
        success: true,
      });

      return reply.send({ message: 'Repo wiped', app_id: ctx.appId });
    } catch (error) {
      return handleRepoRouteError(app, request, reply, error, 'Failed to wipe repo');
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
