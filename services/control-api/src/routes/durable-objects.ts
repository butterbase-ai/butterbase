// services/control-api/src/routes/durable-objects.ts
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
  EXTERNAL_DB_ERROR,
  EXTERNAL_CLOUDFLARE_ERROR,
} from '@butterbase/shared/error-types';
import { requireUserId } from '../utils/require-auth.js';
import * as Service from '../services/durable-objects.service.js';
import { logFromRequest } from '../services/audit/with-audit.js';

const registerSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  access_mode: z.enum(['public', 'authenticated', 'service_key']).default('authenticated'),
});

const setEnvSchema = z.object({
  value: z.string().max(8 * 1024, 'Env value too long (max 8 KB).'),
});

// Maps internal DurableObjectError.code values to HTTP status, agent error
// code, and a remediation hint. Centralized so register/delete share the
// translation and we never bubble a CF error as a generic 500.
function mapDoErrorStatus(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'INVALID_NAME':
    case 'INVALID_SOURCE':
    case 'INVALID_ENV_KEY':
    case 'RESERVED_ENV_KEY':
    case 'ENV_BINDING_COLLISION':
    case 'EMPTY_BUNDLE':
      return 400;
    case 'CF_MIGRATION_TAG_MISMATCH':
    case 'CF_INVALID_MIGRATION':
    case 'CF_DEPLOY_FAILED':
      return 502;
    default:
      return 400;
  }
}

function mapDoErrorCode(code: string) {
  switch (code) {
    case 'NOT_FOUND':
      return RESOURCE_NOT_FOUND;
    case 'CF_MIGRATION_TAG_MISMATCH':
    case 'CF_INVALID_MIGRATION':
    case 'CF_DEPLOY_FAILED':
      return EXTERNAL_CLOUDFLARE_ERROR;
    case 'EMPTY_BUNDLE':
      return EXTERNAL_DB_ERROR;
    default:
      return VALIDATION_INVALID_SCHEMA;
  }
}

function mapDoErrorRemediation(code: string): string {
  switch (code) {
    case 'NOT_FOUND':
      return 'Use list_durable_objects to see registered DOs.';
    case 'CF_MIGRATION_TAG_MISMATCH':
      return 'The local deploy state lost its Cloudflare migration tag. Retry — the service will attempt to backfill it from CF on the next call. If it persists, contact support so the script can be reset.';
    case 'CF_INVALID_MIGRATION':
      return 'Cloudflare rejected the DO migration shape. Check that you are not renaming an existing class without an explicit rename migration.';
    case 'INVALID_ENV_KEY':
      return 'Use uppercase identifiers for DO env keys (e.g. APP_ID, API_BASE_URL).';
    case 'RESERVED_ENV_KEY':
      return 'Rename the key. BUTTERBASE_* is reserved for platform-injected values.';
    case 'ENV_BINDING_COLLISION':
      return 'Pick an env var name that does not match a DO class binding name (UPPER_SNAKE form of the class URL name).';
    case 'CF_DEPLOY_FAILED':
      return 'Cloudflare rejected the deploy. Retry; if it persists, check the Cloudflare status page or contact support with the original error.';
    default:
      return 'Fix the source code or input and retry. See https://docs.butterbase.ai/core-concepts/durable-objects';
  }
}

function periodStartCurrentMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export async function registerDurableObjectRoutes(fastify: FastifyInstance) {
  const { controlDb } = fastify as any;
  const runtimeDb = (appId: string) => getRuntimeDbForApp(fastify.controlDb, appId);

  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppNotFoundError) {
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'App not found',
        remediation: 'Verify the app_id is correct.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }
    const invalid = detectInvalidInput(error);
    if (invalid.isInvalidInput) {
      return reply.code(400).send(createInvalidInputError(invalid.code!, invalid.detail));
    }
    const constraint = detectConstraintViolation(error);
    if (constraint.isConstraint) {
      return reply.code(400).send(createConstraintViolationError(constraint.constraintType!, constraint.details!, { column: constraint.column, tableName: constraint.tableName }));
    }
    throw error;
  });

  // POST: register/update DO class
  fastify.post('/v1/:appId/durable-objects', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const body = registerSchema.parse(request.body);
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);

    try {
      const result = await Service.registerDurableObject((await runtimeDb(appId)), controlDb, appId, userId, body);
      logFromRequest(request, {
        appId, category: 'admin', eventType: 'durable_object.create',
        action: 'create', resourceType: 'durable_object', resourceId: result.id,
        eventData: { name: body.name }, success: true,
      });
      return reply.send(result);
    } catch (error) {
      if (error instanceof Service.DurableObjectError) {
        return reply.status(mapDoErrorStatus(error.code)).send(createAgentError({
          code: mapDoErrorCode(error.code),
          message: error.message,
          remediation: mapDoErrorRemediation(error.code),
          documentation_url: getDocUrl(mapDoErrorCode(error.code)),
        }));
      }
      // Catch-all: never bubble as a generic 500 — surface enough detail for
      // the MCP user to understand what failed.
      const msg = error instanceof Error ? error.message : String(error);
      request.log.error({ err: error }, 'unexpected error in registerDurableObject');
      return reply.status(500).send(createAgentError({
        code: EXTERNAL_CLOUDFLARE_ERROR,
        message: `Unexpected error while deploying Durable Object: ${msg}`,
        remediation: 'Retry; if persistent, share the error message with support.',
        documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR),
      }));
    }
  });

  // GET: list DO classes
  fastify.get('/v1/:appId/durable-objects', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    await AppResolver.resolveApp(controlDb, appId, requireUserId(request), request.auth?.organizationId ?? null);
    const rows = await Service.listDurableObjects((await runtimeDb(appId)), appId);
    return reply.send({ durable_objects: rows });
  });

  // GET: one DO (with source)
  fastify.get('/v1/:appId/durable-objects/:name', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    await AppResolver.resolveApp(controlDb, appId, requireUserId(request), request.auth?.organizationId ?? null);
    const row = await Service.getDurableObject((await runtimeDb(appId)), appId, name);
    if (!row) {
      return reply.status(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Durable Object not found',
        remediation: 'Use list_durable_objects to see registered DOs.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }
    return reply.send(row);
  });

  // DELETE: remove DO class
  fastify.delete('/v1/:appId/durable-objects/:name', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);
    try {
      await Service.deleteDurableObject((await runtimeDb(appId)), controlDb, appId, name);
      logFromRequest(request, {
        appId, category: 'admin', eventType: 'durable_object.delete',
        action: 'delete', resourceType: 'durable_object', resourceId: name, success: true,
      });
      return reply.send({ deleted: true, name });
    } catch (error) {
      if (error instanceof Service.DurableObjectError) {
        return reply.status(mapDoErrorStatus(error.code)).send(createAgentError({
          code: mapDoErrorCode(error.code),
          message: error.message,
          remediation: mapDoErrorRemediation(error.code),
          documentation_url: getDocUrl(mapDoErrorCode(error.code)),
        }));
      }
      const msg = error instanceof Error ? error.message : String(error);
      request.log.error({ err: error }, 'unexpected error in deleteDurableObject');
      return reply.status(500).send(createAgentError({
        code: EXTERNAL_CLOUDFLARE_ERROR,
        message: `Unexpected error while deleting Durable Object: ${msg}`,
        remediation: 'Retry; if persistent, share the error message with support.',
        documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR),
      }));
    }
  });

  // GET: usage
  fastify.get('/v1/:appId/durable-objects/:name/usage', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    await AppResolver.resolveApp(controlDb, appId, requireUserId(request), request.auth?.organizationId ?? null);
    // usage_meters is a control-plane table — query via controlDb (not runtimeDb)
    const usage = await Service.getDurableObjectUsage(controlDb, appId, name, periodStartCurrentMonth());
    return reply.send(usage);
  });

  // GET: list env var keys (values are write-only — never returned by API)
  fastify.get('/v1/:appId/durable-objects/env', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId } = request.params as { appId: string };
    await AppResolver.resolveApp(controlDb, appId, requireUserId(request), request.auth?.organizationId ?? null);
    const keys = await Service.listDoEnvVarKeys((await runtimeDb(appId)), appId);
    return reply.send({ keys });
  });

  // PUT: upsert one env var. Triggers a redeploy if any DO classes are active.
  fastify.put('/v1/:appId/durable-objects/env/:key', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, key } = request.params as { appId: string; key: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);
    const body = setEnvSchema.parse(request.body);

    try {
      const result = await Service.setDoEnvVar((await runtimeDb(appId)), controlDb, appId, key, body.value);
      logFromRequest(request, {
        appId, category: 'admin', eventType: 'durable_object.env.set',
        action: 'update', resourceType: 'durable_object', resourceId: key,
        eventData: { redeployed: result.redeployed }, success: true,
      });
      return reply.send({ key, redeployed: result.redeployed });
    } catch (error) {
      if (error instanceof Service.DurableObjectError) {
        return reply.status(mapDoErrorStatus(error.code)).send(createAgentError({
          code: mapDoErrorCode(error.code),
          message: error.message,
          remediation: mapDoErrorRemediation(error.code),
          documentation_url: getDocUrl(mapDoErrorCode(error.code)),
        }));
      }
      const msg = error instanceof Error ? error.message : String(error);
      request.log.error({ err: error }, 'unexpected error in setDoEnvVar');
      return reply.status(500).send(createAgentError({
        code: EXTERNAL_CLOUDFLARE_ERROR,
        message: `Unexpected error while setting DO env var: ${msg}`,
        remediation: 'Retry; if persistent, share the error message with support.',
        documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR),
      }));
    }
  });

  // DELETE: remove one env var. Also triggers a redeploy.
  fastify.delete('/v1/:appId/durable-objects/env/:key', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, key } = request.params as { appId: string; key: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);

    try {
      const result = await Service.deleteDoEnvVar((await runtimeDb(appId)), controlDb, appId, key);
      logFromRequest(request, {
        appId, category: 'admin', eventType: 'durable_object.env.delete',
        action: 'delete', resourceType: 'durable_object', resourceId: key,
        eventData: { redeployed: result.redeployed }, success: true,
      });
      return reply.send({ deleted: true, key, redeployed: result.redeployed });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      request.log.error({ err: error }, 'unexpected error in deleteDoEnvVar');
      return reply.status(500).send(createAgentError({
        code: EXTERNAL_CLOUDFLARE_ERROR,
        message: `Unexpected error while deleting DO env var: ${msg}`,
        remediation: 'Retry; if persistent, share the error message with support.',
        documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR),
      }));
    }
  });
}
