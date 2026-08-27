import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { rateLimitAllowList } from '../plugins/rate-limit.js';
import { requireUserId } from '../utils/require-auth.js';
import { AppResolver } from '../services/app-resolver.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { getAppPoolForApp } from '../services/app-pool.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { RESOURCE_NOT_FOUND, VALIDATION_INVALID_SCHEMA } from '@butterbase/shared/error-types';
import {
  publishRelease, listReleases, getRelease, updateReleaseText,
  summarizeRelease, NoRepoSnapshotError,
} from '../services/template-releases.js';
import {
  computeDrift, computeDivergence, severLineage, forkBuckets,
} from '../services/app-lineage.js';
import { logFromRequest } from '../services/audit/with-audit.js';

const PublishSchema = z.object({
  label: z.string().trim().min(1).max(80).nullish(),
  notes: z.string().trim().max(10_000).nullish(),
});

export function templateReleaseRoutes(app: FastifyInstance): void {
  // POST /v1/:app_id/template/releases — publish
  app.post('/v1/:app_id/template/releases', {
    config: {
      rateLimit: {
        allowList: rateLimitAllowList,
        max: 20,
        timeWindow: '1 hour',
        keyGenerator: (req) => {
          const { app_id } = req.params as { app_id: string };
          return `app:${app_id}:publish-release`;
        },
      },
    },
  }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const parsed = PublishSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Invalid request body.',
        remediation: 'Send { label?: string, notes?: string }. label is 1-80 chars.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        details: parsed.error.errors,
      }));
    }

    const userId = requireUserId(request);
    const resolved = await AppResolver.resolveApp(
      app.controlDb, app_id, userId, request.auth?.organizationId ?? null,
    );
    const runtimePool = await getRuntimeDbForApp(app.controlDb, resolved.id);
    const appPool = await getAppPoolForApp(app.controlDb, resolved.id, resolved.db_name);

    try {
      const release = await publishRelease(app.controlDb, runtimePool, appPool, {
        sourceAppId: resolved.id,
        publishedBy: userId,
        label: parsed.data.label ?? null,
        notes: parsed.data.notes ?? null,
      });

      logFromRequest(request, {
        appId: resolved.id,
        category: 'admin',
        eventType: 'app.template.release',
        action: 'create',
        resourceType: 'app_config',
        resourceId: String(release.release_number),
        eventData: { release_number: release.release_number, snapshot_id: release.snapshot_id },
        success: true,
      });

      return reply.code(201).send({
        release_number: release.release_number,
        label: release.label,
        notes: release.notes,
        snapshot_id: release.snapshot_id,
        published_at: release.published_at,
      });
    } catch (err) {
      if (err instanceof NoRepoSnapshotError) {
        return reply.code(400).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: 'App has no repo snapshot yet.',
          remediation: 'Run `butterbase repo push` at least once before publishing a release.',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        }));
      }
      throw err;
    }
  });

  // PATCH /v1/:app_id/template/releases/:n — display text only
  app.patch('/v1/:app_id/template/releases/:n', async (request, reply) => {
    const { app_id, n } = request.params as { app_id: string; n: string };
    const parsed = PublishSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Invalid request body.',
        remediation: 'Send { label?: string, notes?: string }.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }
    const resolved = await AppResolver.resolveApp(
      app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null,
    );
    const updated = await updateReleaseText(app.controlDb, resolved.id, parseInt(n, 10), parsed.data);
    if (!updated) {
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Release not found.',
        remediation: 'Check the release number.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }
    return reply.send({ release_number: updated.release_number, label: updated.label, notes: updated.notes });
  });

  // GET /v1/templates/:app_id/releases — anonymous changelog
  app.get('/v1/templates/:app_id/releases', {
    config: {
      rateLimit: {
        allowList: rateLimitAllowList, max: 60, timeWindow: '1 minute',
        keyGenerator: (req) => `ip:${req.ip}:releases-list`,
      },
    },
  }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const releases = await listReleases(app.controlDb, app_id);
    return reply.send({ items: releases.map(summarizeRelease) });
  });

  // GET /v1/templates/:app_id/releases/:n
  //
  // Anonymous callers get the summary. The full manifest (schema DSL, function
  // bodies, policy text) requires org membership on the source or on a fork —
  // "anyone could clone it anyway" is not a good enough basis for serving source
  // code to unauthenticated callers.
  app.get('/v1/templates/:app_id/releases/:n', {
    config: {
      rateLimit: {
        allowList: rateLimitAllowList, max: 60, timeWindow: '1 minute',
        keyGenerator: (req) => `ip:${req.ip}:release-get`,
      },
    },
  }, async (request, reply) => {
    const { app_id, n } = request.params as { app_id: string; n: string };
    const release = await getRelease(app.controlDb, app_id, parseInt(n, 10));
    if (!release) {
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Release not found.',
        remediation: 'Check the app id and release number.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }

    let full = false;
    const userId = request.auth?.userId;
    if (userId) {
      full = await AppResolver.resolveApp(app.controlDb, app_id, userId, request.auth?.organizationId ?? null)
        .then(() => true)
        .catch(() => false);
    }

    const summary = summarizeRelease(release);
    return reply.send(full ? { ...summary, manifest: release.manifest } : summary);
  });

  // GET /v1/:app_id/template/status — this fork's drift + divergence
  app.get('/v1/:app_id/template/status', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const q = request.query as { divergence?: string };
    const resolved = await AppResolver.resolveApp(
      app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null,
    );

    const drift = await computeDrift(app.controlDb, resolved.id);
    const buckets = await forkBuckets(app.controlDb, resolved.id);

    // Divergence needs a live introspect, so it is opt-in per request rather than
    // paid on every dashboard page load.
    let divergence = null;
    if (q.divergence === 'true' && drift.is_fork) {
      const runtimePool = await getRuntimeDbForApp(app.controlDb, resolved.id);
      const appPool = await getAppPoolForApp(app.controlDb, resolved.id, resolved.db_name);
      divergence = await computeDivergence(app.controlDb, runtimePool, appPool, resolved.id);
    }

    return reply.send({ ...drift, divergence, forks: buckets });
  });

  // POST /v1/:app_id/template/sever
  app.post('/v1/:app_id/template/sever', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const resolved = await AppResolver.resolveApp(
      app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null,
    );
    const severed = await severLineage(app.controlDb, resolved.id);

    logFromRequest(request, {
      appId: resolved.id, category: 'admin',
      eventType: 'app.template.sever', action: 'update',
      resourceType: 'app_config', resourceId: 'template_lineage',
      eventData: {}, success: true,
    });

    return reply.send({ severed });
  });
}
