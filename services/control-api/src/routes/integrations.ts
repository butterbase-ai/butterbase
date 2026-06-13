// services/control-api/src/routes/integrations.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppResolver } from '../services/app-resolver.js';
import { verifyEndUserJwt } from '../services/end-user-auth.js';
import { createAgentError } from '../services/error-handler.js';
import { logAuditEvent } from '../services/audit/audit-events-service.js';
import { config } from '../config.js';
import {
  configureIntegration,
  listIntegrationConfigs,
  disableIntegration,
  initiateConnection,
  recordConnection,
  verifyStateToken,
  listConnectedAccounts,
  listAllConnectedAccounts,
  disconnectAccount,
  searchToolkits,
  getToolsForUser,
  executeTool,
  CURATED_TOOLKITS,
} from '../services/composio-client.js';

// Append status params to a redirect URL without clobbering an existing
// query string. `bb.integrations.connect({ redirectUrl })` accepts any
// valid URL, including ones that already carry `?foo=bar`, so a bare
// `${url}?status=...` concat produces `...?foo=bar?status=...` and breaks
// `URLSearchParams.get('foo')` on the client side.
export function withStatusParams(base: string, params: Record<string, string>): string {
  try {
    const url = new URL(base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  } catch {
    // base wasn't a parseable URL — fall back to safe concat. Pre-validated
    // at the connect endpoint via z.string().url(), so this is defense-in-depth.
    const sep = base.includes('?') ? '&' : '?';
    const qs = new URLSearchParams(params).toString();
    return `${base}${sep}${qs}`;
  }
}

// --- Schemas ---

const configureSchema = z.object({
  toolkit: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional(),
  displayName: z.string().max(100).optional(),
});

const connectSchema = z.object({
  toolkit: z.string().min(1).max(100),
  redirectUrl: z.string().url(),
  userId: z.string().uuid().optional(), // For API key auth — specify which user
});

const executeSchema = z.object({
  toolName: z.string().min(1),
  params: z.record(z.unknown()).optional().default({}),
  userId: z.string().uuid().optional(), // For service-level asUser()
});

// --- Helpers ---

/** Resolve end-user ID from JWT or API key + body userId */
async function resolveEndUserId(
  controlDb: any,
  appId: string,
  auth: any,
  bodyUserId?: string,
): Promise<string | null> {
  if (auth?.authMethod === 'end_user_jwt') {
    const claims = await verifyEndUserJwt(controlDb, appId, auth.rawToken!);
    return claims.sub;
  }
  // function_key behaves like api_key on this route: it MUST be combined
  // with a body userId (the runtime always sends one — ctx.integrations.asUser
  // refuses to call without it). We also defensively check that the auth.appId
  // matches the route appId; the onRequest hook should already guarantee this,
  // but route-level checks make the contract explicit.
  if (auth?.authMethod === 'function_key') {
    if (auth.appId !== appId) return null;
    return bodyUserId ?? null;
  }
  if (auth?.authMethod === 'api_key' && bodyUserId) {
    return bodyUserId;
  }
  if (auth?.authMethod === 'api_key' && auth.userId) {
    return auth.userId;
  }
  return null;
}

// --- Route registration ---

export async function integrationRoutes(app: FastifyInstance) {

  // ==========================================
  // GET /v1/:appId/integrations/config — Get integrations config
  // ==========================================
  app.get<{ Params: { appId: string } }>(
    '/v1/:appId/integrations/config',
    async (request, reply) => {
      const { appId } = request.params;
      const auth = request.auth;
      if (!auth?.userId || auth.authMethod === 'end_user_jwt') {
        return reply.status(401).send(createAgentError({
          code: 'AUTH_REQUIRED',
          message: 'API key or platform JWT required',
          remediation: 'Provide an API key (bb_sk_*).',
        }));
      }

      const resolved = await AppResolver.resolveApp(app.controlDb, appId, auth.userId);
      const configs = await listIntegrationConfigs(app.controlDb, resolved.id);

      return reply.send({ app_id: resolved.id, integrations: configs });
    }
  );

  // ==========================================
  // POST /v1/:appId/integrations/configure — Enable an integration
  // ==========================================
  app.post<{ Params: { appId: string } }>(
    '/v1/:appId/integrations/configure',
    async (request, reply) => {
      const { appId } = request.params;
      const auth = request.auth;
      if (!auth?.userId || auth.authMethod === 'end_user_jwt') {
        return reply.status(401).send(createAgentError({
          code: 'AUTH_REQUIRED',
          message: 'API key or platform JWT required',
          remediation: 'Provide an API key.',
        }));
      }

      const body = configureSchema.parse(request.body);
      const resolved = await AppResolver.resolveApp(app.controlDb, appId, auth.userId);

      try {
        const integration = await configureIntegration(
          app.controlDb, resolved.id, body.toolkit, body.scopes, body.displayName,
        );

        await logAuditEvent(app.controlDb, {
          appId: resolved.id,
          category: 'admin',
          eventType: 'integration.configure',
          actorType: 'api_key',
          actorId: auth.userId,
          eventData: { toolkit: body.toolkit, scopes: body.scopes },
          success: true,
        });

        return reply.status(200).send(integration);
      } catch (error: any) {
        if (error.code === 'INTEGRATIONS_NOT_CONFIGURED') {
          return reply.status(400).send(createAgentError({
            code: error.code,
            message: error.message,
            remediation: 'Set COMPOSIO_API_KEY environment variable on the platform.',
          }));
        }
        throw error;
      }
    }
  );

  // ==========================================
  // DELETE /v1/:appId/integrations/configure/:toolkit — Disable integration
  // ==========================================
  app.delete<{ Params: { appId: string; toolkit: string } }>(
    '/v1/:appId/integrations/configure/:toolkit',
    async (request, reply) => {
      const { appId, toolkit } = request.params;
      const auth = request.auth;
      if (!auth?.userId || auth.authMethod === 'end_user_jwt') {
        return reply.status(401).send(createAgentError({
          code: 'AUTH_REQUIRED',
          message: 'API key or platform JWT required',
          remediation: 'Provide an API key.',
        }));
      }

      const resolved = await AppResolver.resolveApp(app.controlDb, appId, auth.userId);
      await disableIntegration(app.controlDb, resolved.id, toolkit);

      await logAuditEvent(app.controlDb, {
        appId: resolved.id,
        category: 'admin',
        eventType: 'integration.disable',
        actorType: 'api_key',
        actorId: auth.userId,
        eventData: { toolkit, action: 'disable' },
        success: true,
      });

      return reply.status(204).send();
    }
  );

  // ==========================================
  // GET /v1/:appId/integrations/available — List available integrations
  // ==========================================
  app.get<{ Params: { appId: string }; Querystring: { search?: string; curated?: string } }>(
    '/v1/:appId/integrations/available',
    async (request, reply) => {
      const auth = request.auth;
      if (!auth?.userId) {
        return reply.status(401).send(createAgentError({
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
          remediation: 'Provide an API key.',
        }));
      }

      const { search } = request.query;

      if (search) {
        // Search the full Composio catalog via toolkits.list()
        // (returns toolkit-level metadata without per-tool fan-out)
        try {
          const result = await searchToolkits(search);
          return reply.send({ integrations: result });
        } catch {
          // Fall back to curated only
        }
      }

      // Return curated list
      const curatedList = CURATED_TOOLKITS.map(slug => ({
        toolkit: slug,
        displayName: slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        curated: true,
      }));
      return reply.send({ integrations: curatedList });
    }
  );

  // ==========================================
  // POST /v1/:appId/integrations/connect — Start OAuth for end-user
  // ==========================================
  app.post<{ Params: { appId: string } }>(
    '/v1/:appId/integrations/connect',
    async (request, reply) => {
      const { appId } = request.params;
      const auth = request.auth;
      const body = connectSchema.parse(request.body);

      const userId = await resolveEndUserId(app.controlDb, appId, auth, body.userId);
      if (!userId) {
        return reply.status(401).send(createAgentError({
          code: 'AUTH_REQUIRED',
          message: 'Authentication required. Provide a user JWT, or API key with userId in body.',
          remediation: 'Provide a user JWT or API key with userId.',
        }));
      }

      try {
        const result = await initiateConnection(
          app.controlDb, appId, userId, body.toolkit, body.redirectUrl,
        );

        await logAuditEvent(app.controlDb, {
          appId,
          category: 'admin',
          eventType: 'integration.connect',
          actorType: auth!.authMethod === 'end_user_jwt' ? 'app_user' : 'api_key',
          actorId: userId,
          eventData: { toolkit: body.toolkit },
          success: true,
        });

        return reply.send(result);
      } catch (error: any) {
        if (error.code === 'INTEGRATIONS_TOOLKIT_NOT_ENABLED') {
          return reply.status(400).send(createAgentError({
            code: error.code,
            message: error.message,
            remediation: `Enable "${body.toolkit}" first with POST /v1/:appId/integrations/configure.`,
          }));
        }
        throw error;
      }
    }
  );

  // ==========================================
  // GET /v1/:appId/integrations/callback — OAuth callback from Composio
  // ==========================================
  // Composio redirects here after the user completes OAuth, appending:
  //   ?state=<our-signed-token>&status=success&connectedAccountId=ca_xxx
  // The state token contains { appId, userId, toolkit, redirectUrl }.
  // By the time this callback fires, the connection is already ACTIVE in
  // Composio — no waitForConnection() needed.
  app.get<{ Params: { appId: string }; Querystring: Record<string, string> }>(
    '/v1/:appId/integrations/callback',
    async (request, reply) => {
      const { appId } = request.params;
      const q = request.query as Record<string, string>;

      // Read both camelCase and snake_case — Composio docs are internally
      // inconsistent about which casing the callback uses. Handle both.
      const state = q.state;
      const status = q.status ?? q.connectionStatus ?? q.connection_status;
      const connectedAccountId = q.connectedAccountId ?? q.connected_account_id;

      // Verify the signed state token
      if (!state) {
        return reply.redirect(withStatusParams(config.dashboardUrl, { status: 'error', message: 'missing_state' }));
      }

      const payload = verifyStateToken(state);
      if (!payload) {
        return reply.redirect(withStatusParams(config.dashboardUrl, { status: 'error', message: 'invalid_state' }));
      }

      // Verify the appId in the URL matches the state token
      if (payload.appId !== appId) {
        return reply.redirect(withStatusParams(payload.redirectUrl, { status: 'error', message: 'app_mismatch' }));
      }

      if (status !== 'success' || !connectedAccountId) {
        return reply.redirect(withStatusParams(payload.redirectUrl, { status: 'error', message: 'connection_failed' }));
      }

      // Record the connection — no polling needed, it's already active
      await recordConnection(
        app.controlDb,
        appId,
        payload.userId,
        payload.toolkit,
        connectedAccountId,
      );

      await logAuditEvent(app.controlDb, {
        appId,
        category: 'admin',
        eventType: 'integration.callback',
        actorType: 'app_user',
        actorId: payload.userId,
        eventData: { toolkit: payload.toolkit, composio_account_id: connectedAccountId },
        success: true,
      });

      return reply.redirect(withStatusParams(payload.redirectUrl, { status: 'connected', toolkit: payload.toolkit }));
    }
  );

  // ==========================================
  // GET /v1/:appId/integrations/connections — List user's connections
  // ==========================================
  app.get<{ Params: { appId: string } }>(
    '/v1/:appId/integrations/connections',
    async (request, reply) => {
      const { appId } = request.params;
      const auth = request.auth;

      if (auth?.authMethod === 'end_user_jwt') {
        const claims = await verifyEndUserJwt(app.controlDb, appId, auth.rawToken!);
        const connections = await listConnectedAccounts(app.controlDb, appId, claims.sub);
        return reply.send({ connections });
      } else if (auth?.authMethod === 'api_key') {
        // Admin: list all connections
        const connections = await listAllConnectedAccounts(app.controlDb, appId);
        return reply.send({ connections });
      }

      return reply.status(401).send(createAgentError({
        code: 'AUTH_REQUIRED',
        message: 'Authentication required',
        remediation: 'Provide a user JWT or API key.',
      }));
    }
  );

  // ==========================================
  // DELETE /v1/:appId/integrations/connections/:id — Disconnect
  // ==========================================
  app.delete<{ Params: { appId: string; id: string } }>(
    '/v1/:appId/integrations/connections/:id',
    async (request, reply) => {
      const { appId, id } = request.params;
      const auth = request.auth;

      const userId = await resolveEndUserId(app.controlDb, appId, auth);
      if (!userId) {
        return reply.status(401).send(createAgentError({
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
          remediation: 'Provide a user JWT or API key.',
        }));
      }

      await disconnectAccount(app.controlDb, appId, userId, id);

      await logAuditEvent(app.controlDb, {
        appId,
        category: 'admin',
        eventType: 'integration.disconnect',
        actorType: auth!.authMethod === 'end_user_jwt' ? 'app_user' : 'api_key',
        actorId: userId,
        eventData: { connection_id: id },
        success: true,
      });

      return reply.status(204).send();
    }
  );

  // ==========================================
  // GET /v1/:appId/integrations/tools — List available tools
  // ==========================================
  app.get<{ Params: { appId: string }; Querystring: { toolkit?: string } }>(
    '/v1/:appId/integrations/tools',
    async (request, reply) => {
      const { appId } = request.params;
      const auth = request.auth;

      const userId = await resolveEndUserId(app.controlDb, appId, auth);
      if (!userId) {
        return reply.status(401).send(createAgentError({
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
          remediation: 'Provide a user JWT or API key.',
        }));
      }

      const tools = await getToolsForUser(app.controlDb, appId, userId, request.query.toolkit);
      return reply.send({ tools });
    }
  );

  // ==========================================
  // POST /v1/:appId/integrations/execute — Execute a tool
  // ==========================================
  app.post<{ Params: { appId: string } }>(
    '/v1/:appId/integrations/execute',
    async (request, reply) => {
      const { appId } = request.params;
      const auth = request.auth;
      const body = executeSchema.parse(request.body);

      // For end-user JWT: use JWT subject
      // For API key: use body.userId (asUser) or auth.userId
      const userId = await resolveEndUserId(app.controlDb, appId, auth, body.userId);
      if (!userId) {
        return reply.status(401).send(createAgentError({
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
          remediation: 'Provide a user JWT or API key with userId.',
        }));
      }

      let result: Awaited<ReturnType<typeof executeTool>>;
      try {
        result = await executeTool(
          app.controlDb, appId, userId, body.toolName, body.params || {},
        );
      } catch (error: any) {
        if (error.code === 'INTEGRATIONS_NOT_CONFIGURED') {
          return reply.status(400).send(createAgentError({
            code: error.code,
            message: error.message,
            remediation: 'Set COMPOSIO_API_KEY environment variable on the platform.',
          }));
        }
        throw error;
      }

      await logAuditEvent(app.controlDb, {
        appId,
        category: 'admin',
        eventType: 'integration.execute',
        actorType:
          auth!.authMethod === 'end_user_jwt' ? 'app_user'
          : auth!.authMethod === 'function_key' ? 'function_key'
          : 'api_key',
        actorId: userId,
        eventData: { tool: body.toolName, successful: result.successful },
        success: result.successful,
      });

      if (!result.successful) {
        // Distinguish thrown errors (SDK/network failure → 502) from
        // soft failures (upstream 400, quota, etc. → 422)
        const httpStatus = result.thrown ? 502 : 422;
        return reply.status(httpStatus).send(createAgentError({
          code: 'INTEGRATIONS_EXECUTION_FAILED',
          message: result.error || 'Tool execution failed',
          remediation: 'Check the tool name and parameters. Ensure the user has a connected account for this integration.',
        }));
      }

      return reply.send(result);
    }
  );
}
