import type { FastifyInstance } from 'fastify';
import { ApiKeyService, ScopeValidationError } from '../services/api-key-service.js';
import { requireUserId } from '../utils/require-auth.js';
import { resolveOrganizationId } from '../services/org-resolver.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { logFromRequest } from '../services/audit/with-audit.js';

const PLATFORM_APP_ID = '_platform';

export async function apiKeyRoutes(app: FastifyInstance) {
  // POST /api-keys — Generate new API key
  // body.scope='substrate' mints a bb_sub_ key bound to the caller's
  // substrate_user_id; otherwise (default) mints a regular bb_sk_ app key.
  // New fields: key_scope ('account'|'app'), target_app_id, additional_scopes.
  app.post('/api-keys', async (request, reply) => {
    const userId = requireUserId(request);
    const {
      name,
      scopes: legacyScopes,
      scope: substrateAccess,
      key_scope,
      target_app_id,
      additional_scopes,
    } = request.body as {
      name?: string;
      scopes?: string[];
      scope?: 'app' | 'substrate' | 'both';
      key_scope?: 'account' | 'app';
      target_app_id?: string;
      additional_scopes?: string[];
    };

    if (!name || typeof name !== 'string') {
      return reply.code(400).send(createAgentError({
        code: 'VALIDATION_INVALID_SCHEMA',
        message: 'name is required',
        remediation: 'Provide a descriptive name for the API key.',
        documentation_url: getDocUrl('VALIDATION_INVALID_SCHEMA'),
      }));
    }
    if (substrateAccess !== undefined &&
        substrateAccess !== 'app' && substrateAccess !== 'substrate' && substrateAccess !== 'both') {
      return reply.code(400).send(createAgentError({
        code: 'VALIDATION_INVALID_SCOPE',
        message: "scope must be 'app', 'substrate', or 'both'",
        remediation: "Omit the scope field for an app key (default), set 'substrate' for a substrate-only key, or 'both' for a single key that works on both surfaces.",
        documentation_url: getDocUrl('VALIDATION_INVALID_SCOPE'),
      }));
    }
    if (legacyScopes !== undefined && (key_scope !== undefined || additional_scopes !== undefined)) {
      return reply.code(400).send(createAgentError({
        code: 'VALIDATION_INVALID_SCHEMA',
        message: 'Cannot mix legacy `scopes` array with `key_scope`/`additional_scopes`. Use the new fields.',
        remediation: 'Drop the `scopes` field and use `key_scope` plus optional `additional_scopes`.',
        documentation_url: getDocUrl('VALIDATION_INVALID_SCHEMA'),
      }));
    }

    // Legacy `scopes` array (when sent alone) is treated as additional_scopes so
    // the service-layer allowlist validates it instead of silently dropping it.
    const effectiveAdditional = additional_scopes ?? legacyScopes;

    try {
      const result = await ApiKeyService.generateApiKey(
        app.controlDb,
        userId,
        name,
        {
          keyScope: key_scope ?? 'account',
          targetAppId: target_app_id,
          additionalScopes: effectiveAdditional,
          substrateAccess,
        }
      );

      logFromRequest(request, {
        appId: target_app_id ?? PLATFORM_APP_ID,
        category: 'admin',
        eventType: 'api_key.create',
        action: 'create',
        resourceType: 'api_key',
        resourceId: result.keyId,
        eventData: {
          name,
          key_scope: key_scope ?? 'account',
          target_app_id: target_app_id ?? null,
          additional_scopes: effectiveAdditional ?? [],
          substrate_access: substrateAccess ?? 'app',
          prefix: result.prefix,
        },
        success: true,
      });

      return reply.code(201).send(result);
    } catch (e) {
      if (e instanceof ScopeValidationError) {
        return reply.code(400).send(createAgentError({
          code: e.code,
          message: e.message,
          remediation: 'See key_scope/additional_scopes docs for valid values.',
          documentation_url: getDocUrl(e.code),
        }));
      }
      throw e;
    }
  });

  // GET /api-keys — List organization's API keys
  // Optional ?scope=app|substrate|both filters by key type.
  // Optional ?scope=me narrows to the caller's own keys within the org.
  app.get('/api-keys', async (request, reply) => {
    const userId = requireUserId(request);
    const { scope } = request.query as { scope?: string };
    const organizationId = await resolveOrganizationId(app.controlDb, userId);
    const filterScope =
      scope === 'app' || scope === 'substrate' || scope === 'both' ? scope : undefined;
    const narrowToUser = scope === 'me' ? userId : undefined;
    const keys = await ApiKeyService.listKeys(app.controlDb, organizationId, filterScope, narrowToUser);
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
