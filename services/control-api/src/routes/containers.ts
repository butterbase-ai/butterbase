// services/control-api/src/routes/containers.ts
import crypto from 'node:crypto';
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
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import {
  RESOURCE_NOT_FOUND,
  VALIDATION_INVALID_SCHEMA,
  EXTERNAL_CLOUDFLARE_ERROR,
} from '@butterbase/shared/error-types';
import { requireUserId } from '../utils/require-auth.js';
import * as Service from '../services/containers.service.js';
import { logFromRequest } from '../services/audit/with-audit.js';

const registerSchema = z.object({
  name: z.string().min(1),
  image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  mode: z.enum(['pool', 'actor']).default('pool'),
  access_mode: z.enum(['public', 'authenticated', 'service_key']).default('service_key'),
  instance_type: z.enum(['dev', 'basic', 'standard']).default('basic'),
  max_instances: z.number().int().min(1).max(10).default(5),
  sleep_after_s: z.number().int().min(10).max(3600).default(300),
  port: z.number().int().min(1).max(65535).default(8080),
});

const setEnvSchema = z.object({ value: z.string().max(8 * 1024, 'Env value too long (max 8 KB).') });

const imagePushedSchema = z.object({
  registry_repo: z.string().regex(/^app_[a-zA-Z0-9]+\/[a-z][a-z0-9-]*$/),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  size_bytes: z.number().int().nonnegative().optional(),
});

function mapErrorStatus(code: string): number {
  switch (code) {
    case 'NOT_FOUND': return 404;
    case 'IMAGE_NOT_FOUND':
    case 'INVALID_NAME':
    case 'INVALID_ENV_KEY':
    case 'ENV_BINDING_COLLISION':
    case 'QUOTA_EXCEEDED': return 400;
    case 'CF_DEPLOY_FAILED': return 502;
    default: return 400;
  }
}

function mapErrorCode(code: string) {
  switch (code) {
    case 'NOT_FOUND': return RESOURCE_NOT_FOUND;
    case 'CF_DEPLOY_FAILED': return EXTERNAL_CLOUDFLARE_ERROR;
    default: return VALIDATION_INVALID_SCHEMA;
  }
}

function mapErrorRemediation(code: string): string {
  switch (code) {
    case 'NOT_FOUND': return 'Use manage_container action="list" to see deployed containers.';
    case 'IMAGE_NOT_FOUND': return 'Push the image first (manage_container action="registry_credentials" shows how), then deploy with its sha256 digest.';
    case 'QUOTA_EXCEEDED': return 'Delete an unused container or contact support to raise the limit.';
    case 'CF_DEPLOY_FAILED': return 'Retry; if it persists, check the Cloudflare status page or contact support with the original error.';
    default: return 'Fix the input and retry. See https://docs.butterbase.ai/core-concepts/containers';
  }
}

function sendContainerError(reply: any, error: Service.ContainerError) {
  return reply.status(mapErrorStatus(error.code)).send(createAgentError({
    code: mapErrorCode(error.code),
    message: error.message,
    remediation: mapErrorRemediation(error.code),
    documentation_url: getDocUrl(mapErrorCode(error.code)),
  }));
}

export async function registerContainerRoutes(fastify: FastifyInstance) {
  const { controlDb } = fastify as any;
  const runtimeDb = (appId: string) => getRuntimeDbForApp(fastify.controlDb, appId);

  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppNotFoundError) {
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND, message: 'App not found',
        remediation: 'Verify the app_id is correct.', documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }
    const invalid = detectInvalidInput(error);
    if (invalid.isInvalidInput) return reply.code(400).send(createInvalidInputError(invalid.code!, invalid.detail));
    const constraint = detectConstraintViolation(error);
    if (constraint.isConstraint) {
      return reply.code(400).send(createConstraintViolationError(constraint.constraintType!, constraint.details!, { column: constraint.column, tableName: constraint.tableName }));
    }
    throw error;
  });

  // POST: deploy (register/update) a container from an already-pushed image
  fastify.post('/v1/:appId/containers', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const body = registerSchema.parse(request.body);
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId);
    try {
      const result = await Service.registerContainer(await runtimeDb(appId), controlDb, appId, userId, body);
      logFromRequest(request, {
        appId, category: 'admin', eventType: 'container.deploy',
        action: 'create', resourceType: 'container', resourceId: result.id,
        eventData: { name: body.name, digest: body.image_digest }, success: true,
      });
      return reply.send(result);
    } catch (error) {
      if (error instanceof Service.ContainerError) return sendContainerError(reply, error);
      const msg = error instanceof Error ? error.message : String(error);
      request.log.error({ err: error }, 'unexpected error in registerContainer');
      return reply.status(500).send(createAgentError({
        code: EXTERNAL_CLOUDFLARE_ERROR,
        message: `Unexpected error while deploying container: ${msg}`,
        remediation: 'Retry; if persistent, share the error message with support.',
        documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR),
      }));
    }
  });

  // GET list
  fastify.get('/v1/:appId/containers', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));
    return reply.send({ containers: await Service.listContainers(await runtimeDb(appId), appId) });
  });

  // GET one
  fastify.get('/v1/:appId/containers/:name', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));
    const row = await Service.getContainer(await runtimeDb(appId), appId, name);
    if (!row) {
      return reply.status(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND, message: 'Container not found',
        remediation: 'Use manage_container action="list".', documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }
    return reply.send(row);
  });

  // DELETE
  fastify.delete('/v1/:appId/containers/:name', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId);
    try {
      await Service.deleteContainer(await runtimeDb(appId), controlDb, appId, name);
      logFromRequest(request, {
        appId, category: 'admin', eventType: 'container.delete',
        action: 'delete', resourceType: 'container', resourceId: name, success: true,
      });
      return reply.send({ deleted: true, name });
    } catch (error) {
      if (error instanceof Service.ContainerError) return sendContainerError(reply, error);
      throw error;
    }
  });

  // GET env keys
  fastify.get('/v1/:appId/containers/:name/env', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    await AppResolver.resolveApp(controlDb, appId, requireUserId(request));
    try {
      return reply.send({ keys: await Service.listContainerEnvVarKeys(await runtimeDb(appId), appId, name) });
    } catch (error) {
      if (error instanceof Service.ContainerError) return sendContainerError(reply, error);
      throw error;
    }
  });

  // PUT env var
  fastify.put('/v1/:appId/containers/:name/env/:key', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name, key } = request.params as { appId: string; name: string; key: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId);
    const body = setEnvSchema.parse(request.body);
    try {
      const result = await Service.setContainerEnvVar(await runtimeDb(appId), controlDb, appId, name, key, body.value);
      logFromRequest(request, {
        appId, category: 'admin', eventType: 'container.env.set',
        action: 'update', resourceType: 'container', resourceId: `${name}/${key}`,
        eventData: { redeployed: result.redeployed }, success: true,
      });
      return reply.send({ key, redeployed: result.redeployed });
    } catch (error) {
      if (error instanceof Service.ContainerError) return sendContainerError(reply, error);
      throw error;
    }
  });

  // DELETE env var
  fastify.delete('/v1/:appId/containers/:name/env/:key', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name, key } = request.params as { appId: string; name: string; key: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId);
    try {
      const result = await Service.deleteContainerEnvVar(await runtimeDb(appId), controlDb, appId, name, key);
      logFromRequest(request, {
        appId, category: 'admin', eventType: 'container.env.delete',
        action: 'delete', resourceType: 'container', resourceId: `${name}/${key}`,
        eventData: { redeployed: result.redeployed }, success: true,
      });
      return reply.send({ deleted: true, key, redeployed: result.redeployed });
    } catch (error) {
      if (error instanceof Service.ContainerError) return sendContainerError(reply, error);
      throw error;
    }
  });

  // INTERNAL: registry facade asks "may this bb_sk_ key push to this repo?"
  //
  // The api_keys table binds keys to a user_id, NOT to an app (scopes are
  // '*' / 'ai:gateway', never 'app:<id>' — verified in api-key-service.ts and
  // db/control-plane/002_api_keys.sql). So we resolve the key's owner, then
  // confirm that owner owns the repo's app via user_app_index, and echo the
  // repo's app_id back. A key whose owner does not own the app => { app_id: null }.
  fastify.post('/internal/registry/auth-check', async (request, reply) => {
    const secret = request.headers['x-registry-shared-secret'];
    if (!secret || secret !== process.env.REGISTRY_FACADE_SHARED_SECRET) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const { key, repo } = (request.body ?? {}) as { key?: string; repo?: string };
    if (!key || !key.startsWith('bb_sk_')) return reply.send({ app_id: null });

    const hash = crypto.createHash('sha256').update(key).digest('hex');
    const keyRow = await controlDb.query(
      `SELECT user_id FROM api_keys
       WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [hash],
    );
    if (keyRow.rows.length === 0) return reply.send({ app_id: null });
    const userId = keyRow.rows[0].user_id as string;

    // No repo context (the /v2/ version probe): confirm the key is valid and the
    // owner has at least one app, returning that app_id so the probe succeeds.
    if (!repo) {
      const anyApp = await controlDb.query(
        `SELECT app_id FROM user_app_index WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      return reply.send({ app_id: anyApp.rows[0]?.app_id ?? null });
    }

    // repo is '{app_id}/{name}' — verify the key's owner owns that app.
    const appId = repo.split('/')[0];
    const owned = await controlDb.query(
      `SELECT 1 FROM user_app_index WHERE app_id = $1 AND user_id = $2`,
      [appId, userId],
    );
    return reply.send({ app_id: owned.rows.length > 0 ? appId : null });
  });

  // INTERNAL: registry facade notifies a completed manifest push.
  // Shared-secret auth (auth check BEFORE schema parse).
  fastify.post('/internal/registry/image-pushed', async (request, reply) => {
    const secret = request.headers['x-registry-shared-secret'];
    if (!secret || secret !== process.env.REGISTRY_FACADE_SHARED_SECRET) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const parsed = imagePushedSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const body = parsed.data;
    await controlDb.query(
      `INSERT INTO container_images (registry_repo, digest, size_bytes, source)
       VALUES ($1, $2, $3, 'push')
       ON CONFLICT (registry_repo, digest) DO UPDATE SET size_bytes = COALESCE(EXCLUDED.size_bytes, container_images.size_bytes)`,
      [body.registry_repo, body.digest, body.size_bytes ?? null],
    );
    return reply.send({ ok: true });
  });
}
