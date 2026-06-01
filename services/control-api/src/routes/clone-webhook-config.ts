import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { upsertCloneWebhook, deleteCloneWebhook } from '../services/clone-webhook-store.js';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { RESOURCE_NOT_FOUND, VALIDATION_INVALID_SCHEMA, EXTERNAL_DB_ERROR } from '@butterbase/shared/error-types';
import { requireUserId } from '../utils/require-auth.js';
import { logFromRequest } from '../services/audit/with-audit.js';

const SetSchema = z.object({
  webhook_url: z.string().url(),
  webhook_secret: z.string().min(16).max(256),
});
const ClearSchema = z.object({ clear: z.literal(true) });
const BodySchema = z.union([SetSchema, ClearSchema]);

export async function cloneWebhookConfigRoutes(app: FastifyInstance) {
  // PATCH /v1/:app_id/config/clone-webhook - Upsert or clear a clone webhook
  app.patch('/v1/:app_id/config/clone-webhook', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    const parseResult = BodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Invalid request body',
        remediation: 'Provide { webhook_url, webhook_secret } to set a webhook, or { clear: true } to remove it. webhook_secret must be 16–256 characters.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        details: parseResult.error.errors,
      }));
    }

    try {
      const resolvedApp = await AppResolver.resolveApp(
        app.controlDb,
        app_id,
        requireUserId(request)
      );

      if ('clear' in parseResult.data && parseResult.data.clear === true) {
        await deleteCloneWebhook(app.controlDb, resolvedApp.id);

        logFromRequest(request, {
          appId: resolvedApp.id,
          category: 'admin',
          eventType: 'app.config.clone_webhook',
          action: 'delete',
          resourceType: 'app_config',
          resourceId: 'clone_webhook',
          eventData: {},
          success: true,
        });

        return reply.send({
          app_id: resolvedApp.id,
          clone_webhook_configured: false,
        });
      } else {
        const { webhook_url, webhook_secret } = parseResult.data as z.infer<typeof SetSchema>;
        await upsertCloneWebhook(app.controlDb, resolvedApp.id, webhook_url, webhook_secret);

        logFromRequest(request, {
          appId: resolvedApp.id,
          category: 'admin',
          eventType: 'app.config.clone_webhook',
          action: 'update',
          resourceType: 'app_config',
          resourceId: 'clone_webhook',
          eventData: { webhook_url },
          success: true,
        });

        return reply.send({
          app_id: resolvedApp.id,
          clone_webhook_configured: true,
          webhook_url,
        });
      }
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }
      app.log.error({ error }, 'Failed to update clone webhook config');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to update clone webhook config',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });
}
