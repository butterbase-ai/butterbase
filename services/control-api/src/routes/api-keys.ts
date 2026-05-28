import type { FastifyInstance } from 'fastify';
import { ApiKeyService } from '../services/api-key-service.js';
import { requireUserId } from '../utils/require-auth.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { logFromRequest } from '../services/audit/with-audit.js';

const PLATFORM_APP_ID = '_platform';

export async function apiKeyRoutes(app: FastifyInstance) {
  // POST /api-keys — Generate new API key
  app.post('/api-keys', async (request, reply) => {
    const userId = requireUserId(request);
    const { name, scopes } = request.body as { name: string; scopes?: string[] };

    if (!name || typeof name !== 'string') {
      return reply.code(400).send(createAgentError({
        code: 'VALIDATION_INVALID_SCHEMA',
        message: 'name is required',
        remediation: 'Provide a descriptive name for the API key.',
        documentation_url: getDocUrl('VALIDATION_INVALID_SCHEMA'),
      }));
    }

    // Validate `app:<appId>` scopes against ownership. Without this check the
    // delegation path (granting a key access to a specific app's AI routes)
    // would let any logged-in user mint a key bearing another developer's app
    // scope and drain that owner's credits — exactly the leak we're closing.
    const appScopes = (scopes ?? []).filter((s) => typeof s === 'string' && s.startsWith('app:'));
    if (appScopes.length > 0) {
      const appIds = Array.from(new Set(appScopes.map((s) => s.slice('app:'.length))));
      const r = await app.controlDb.query<{ id: string }>(
        `SELECT id FROM apps WHERE owner_id = $1 AND id = ANY($2::text[])`,
        [userId, appIds]
      );
      const owned = new Set(r.rows.map((row) => row.id));
      const notOwned = appIds.filter((id) => !owned.has(id));
      if (notOwned.length > 0) {
        return reply.code(403).send(createAgentError({
          code: 'AUTH_INSUFFICIENT_PERMISSIONS',
          message: `Cannot grant scopes for apps you don't own: ${notOwned.map((id) => `app:${id}`).join(', ')}`,
          remediation: 'Only the owner of an app may mint a key bearing its `app:<appId>` scope.',
          documentation_url: getDocUrl('AUTH_INSUFFICIENT_PERMISSIONS'),
        }));
      }
    }

    const result = await ApiKeyService.generateApiKey(
      app.controlDb,
      userId,
      name,
      scopes
    );

    logFromRequest(request, {
      appId: PLATFORM_APP_ID,
      category: 'admin',
      eventType: 'api_key.create',
      action: 'create',
      resourceType: 'api_key',
      resourceId: result.keyId,
      eventData: { name, scopes: scopes ?? ['*'], prefix: result.prefix },
      success: true,
    });

    return reply.code(201).send(result);
  });

  // GET /api-keys — List user's API keys
  app.get('/api-keys', async (request, reply) => {
    const userId = requireUserId(request);
    const keys = await ApiKeyService.listKeys(app.controlDb, userId);
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
