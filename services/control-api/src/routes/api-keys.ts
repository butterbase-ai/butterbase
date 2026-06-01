import type { FastifyInstance } from 'fastify';
import { ApiKeyService } from '../services/api-key-service.js';
import { requireUserId } from '../utils/require-auth.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { logFromRequest } from '../services/audit/with-audit.js';

const PLATFORM_APP_ID = '_platform';

export async function apiKeyRoutes(app: FastifyInstance) {
  // POST /api-keys — Generate new API key
  // body.scope='substrate' mints a bb_sub_ key bound to the caller's
  // substrate_user_id; otherwise (default) mints a regular bb_sk_ app key.
  app.post('/api-keys', async (request, reply) => {
    const userId = requireUserId(request);
    const { name, scopes, scope } = request.body as {
      name?: string;
      scopes?: string[];
      scope?: 'app' | 'substrate' | 'both';
    };

    if (!name || typeof name !== 'string') {
      return reply.code(400).send(createAgentError({
        code: 'VALIDATION_INVALID_SCHEMA',
        message: 'name is required',
        remediation: 'Provide a descriptive name for the API key.',
        documentation_url: getDocUrl('VALIDATION_INVALID_SCHEMA'),
      }));
    }
    if (scope !== undefined && scope !== 'app' && scope !== 'substrate' && scope !== 'both') {
      return reply.code(400).send({
        error: 'INVALID_SCOPE',
        message: "scope must be 'app', 'substrate', or 'both'",
        remediation: "Omit the scope field for an app key (default), set 'substrate' for a substrate-only key, or 'both' for a single key that works on both surfaces.",
      });
    }

    const result = await ApiKeyService.generateApiKey(
      app.controlDb,
      userId,
      name,
      scopes,
      scope
    );

    logFromRequest(request, {
      appId: PLATFORM_APP_ID,
      category: 'admin',
      eventType: 'api_key.create',
      action: 'create',
      resourceType: 'api_key',
      resourceId: result.keyId,
      eventData: { name, scopes: scopes ?? ['*'], scope: scope ?? 'app', prefix: result.prefix },
      success: true,
    });

    return reply.code(201).send(result);
  });

  // GET /api-keys — List user's API keys
  app.get('/api-keys', async (request, reply) => {
    const userId = requireUserId(request);
    const { scope } = request.query as { scope?: string };
    const filterScope =
      scope === 'app' || scope === 'substrate' || scope === 'both' ? scope : undefined;
    const keys = await ApiKeyService.listKeys(app.controlDb, userId, filterScope);
    return { keys };
  });

  // DELETE /api-keys/:keyId — Revoke an API key
  app.delete('/api-keys/:keyId', async (request, reply) => {
    const userId = requireUserId(request);
    const { keyId } = request.params as { keyId: string };

    const revoked = await ApiKeyService.revokeKey(app.controlDb, keyId, userId);
    if (!revoked) {
      return reply.code(404).send(createAgentError({
        code: 'RESOURCE_NOT_FOUND',
        message: 'API key not found',
        remediation: 'Verify the key ID is correct. The key may already be revoked.',
        documentation_url: getDocUrl('RESOURCE_NOT_FOUND'),
      }));
    }

    logFromRequest(request, {
      appId: PLATFORM_APP_ID,
      category: 'admin',
      eventType: 'api_key.revoke',
      action: 'delete',
      resourceType: 'api_key',
      resourceId: keyId,
      success: true,
    });

    return { revoked: true };
  });
}
