import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUserId } from '../utils/require-auth.js';
import { getRedisClient } from '../services/redis.js';
import { readCatalogEntry } from '../services/ai-router/catalog.js';
import { resolveAssistantModel } from '../services/dashboard-agent/assistant-model.js';
import { resolveOperatorModel } from '../services/dashboard-agent/operator-turn.js';
import { readModelPreference, saveModelPreference } from '../services/dashboard-agent/model-preferences.js';

const bodySchema = z.object({ model: z.string().trim().min(1).max(200).nullable() }).strict();
/** Registered under /v1/dashboard-agent alongside the existing conversation API. */
export function registerAgentModelPreferencesRoutes(app: FastifyInstance, enabled: () => boolean): void {
  for (const [path, organization] of [['/preferences', false], ['/operator/model', true]] as const) {
    for (const method of ['GET', 'PATCH'] as const) app.route({ method, url: path, handler: async (request, reply) => {
      if (!enabled()) return reply.code(404).send({ error: 'not enabled' });
      const userId = requireUserId(request);
      if (request.auth.authMethod !== 'jwt') return reply.code(403).send({ error: 'Sign in to manage model settings.' });
      const org = organization ? z.string().uuid().safeParse(request.headers['x-organization-id']) : null;
      if (org && !org.success) return reply.code(400).send({ error: 'Select an organization.' });
      const scope = { userId, ...(org?.success ? { organizationId: org.data } : {}) };
      // Authorize before reading the catalog or accepting a write.
      let model = await readModelPreference(app.controlDb, scope);
      if (method === 'PATCH') {
        const body = bodySchema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: 'Choose a model or reset to the default.' });
        if (body.data.model !== null) {
          const entry = await readCatalogEntry(getRedisClient(), body.data.model);
          if (!entry?.routers.some(router => (router.modality ?? 'chat') === 'chat')) {
            return reply.code(400).send({ error: 'Choose an available chat model.' });
          }
        }
        model = await saveModelPreference(app.controlDb, scope, body.data.model);
      }
      const platformDefault = organization ? resolveOperatorModel() : resolveAssistantModel();
      return { model, effective_model: model ?? platformDefault, platform_default_model: platformDefault };
    } });
  }
}
