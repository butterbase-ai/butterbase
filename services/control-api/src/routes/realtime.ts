import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { getAppPoolForApp } from '../services/app-pool.js';
import { introspectSchema } from '../services/schema-introspector.js';
import { AppResolver, AppNotFoundError, AppAuthRequiredError, AppPausedError, assertAppNotPaused } from '../services/app-resolver.js';
import { verifyEndUserJwt } from '../services/end-user-auth.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import {
  RESOURCE_NOT_FOUND,
  VALIDATION_TABLE_NOT_FOUND,
} from '@butterbase/shared/error-types';
import { config } from '../config.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { logFromRequest } from '../services/audit/with-audit.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve auth from the upgrade request — same logic as auto-api resolveAppAndPool
 * but doesn't need to return a pool (the manager handles that).
 */
async function resolveRealtimeAuth(
  controlDb: Pool,
  appId: string,
  auth: any
): Promise<{
  dbName: string;
  role: 'butterbase_anon' | 'butterbase_user' | 'butterbase_service';
  userId: string | null;
}> {
  if (auth.authMethod === 'end_user_jwt') {
    const endUserClaims = await verifyEndUserJwt(controlDb, appId, auth.rawToken!);
    const app = await AppResolver.resolveAppPublic(controlDb, appId);
    assertAppNotPaused(app);
    return { dbName: app.db_name, role: 'butterbase_user', userId: endUserClaims.sub };
  } else if (auth.authMethod === 'api_key' || auth.authMethod === 'jwt') {
    const app = await AppResolver.resolveApp(controlDb, appId, auth.userId!);
    assertAppNotPaused(app);
    return { dbName: app.db_name, role: 'butterbase_service', userId: null };
  } else {
    const app = await AppResolver.resolveAppPublic(controlDb, appId);
    assertAppNotPaused(app);
    if (app.access_mode === 'authenticated') {
      throw new AppAuthRequiredError(appId);
    }
    return { dbName: app.db_name, role: 'butterbase_anon', userId: null };
  }
}

// ============================================================================
// WebSocket trigger support
// ============================================================================

/** Cache of app_id → { functions, expires } for websocket-triggered function lookups */
const wsTriggerCache = new Map<string, { functions: Map<string, string>; expires: number }>();
const WS_TRIGGER_CACHE_TTL = 5000;

async function handleWebSocketEvent(
  fastify: FastifyInstance,
  appId: string,
  userId: string | null,
  event: string,
  payload: unknown,
  socket: import('ws').WebSocket
): Promise<void> {
  try {
    // Lookup function name for this event (cached)
    let cached = wsTriggerCache.get(appId);
    if (!cached || cached.expires < Date.now()) {
      const runtimePool = await getRuntimeDbForApp(fastify.controlDb, appId);
      const result = await runtimePool.query<{ name: string; trigger_config: { event?: string } }>(
        `SELECT name, trigger_config FROM app_functions
         WHERE app_id = $1 AND trigger_type = 'websocket'`,
        [appId]
      );
      const functions = new Map<string, string>();
      for (const row of result.rows) {
        const eventName = row.trigger_config?.event;
        if (eventName) functions.set(eventName, row.name);
      }
      cached = { functions, expires: Date.now() + WS_TRIGGER_CACHE_TTL };
      wsTriggerCache.set(appId, cached);
    }

    const functionName = cached.functions.get(event);
    if (!functionName) {
      socket.send(JSON.stringify({ type: 'error', message: `No handler for event: ${event}` }));
      return;
    }

    // Forward to Deno runtime
    const response = await fetch(
      `${config.runtimeUrl}/execute/${appId}/${functionName}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId || '',
          'x-app-id': appId,
        },
        body: JSON.stringify({ event, payload }),
      }
    );

    const body = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      data = body;
    }

    socket.send(JSON.stringify({ type: 'event_response', event, data }));
  } catch (err) {
    fastify.log.error({ err, appId, event }, '[Realtime] WebSocket trigger failed');
    socket.send(JSON.stringify({ type: 'error', message: 'Event handler execution failed' }));
  }
}

// ============================================================================
// Routes
// ============================================================================

export async function realtimeRoutes(app: FastifyInstance) {
  const runtimeDbForApp = (appId: string) => getRuntimeDbForApp(app.controlDb, appId);
  // --------------------------------------------------------------------------
  // WebSocket endpoint: GET /v1/:app_id/realtime
  // --------------------------------------------------------------------------

  app.get('/v1/:app_id/realtime', {
    websocket: true,
    config: { public: true, requiresAppRegion: true, migrationGuard: true },
  }, async (socket, request) => {
    const { app_id } = request.params as { app_id: string };

    // -----------------------------------------------------------------------
    // Resolve auth: support both Authorization header and ?token= query param.
    // Browser WebSocket API does not support custom headers, so clients must
    // pass their JWT (or API key) via the query string instead.
    // -----------------------------------------------------------------------
    let auth = request.auth;
    if (!auth || auth.authMethod === 'anonymous') {
      const query = request.query as Record<string, string | undefined>;
      const tokenFromQuery = query.token;
      if (tokenFromQuery) {
        if (tokenFromQuery.startsWith('bb_sk_')) {
          // API key via query param
          auth = { userId: null, authMethod: 'api_key', scopes: ['*'] } as any;
          // Validate the key
          try {
            const { ApiKeyService } = await import('../services/api-key-service.js');
            const keyAuth = await ApiKeyService.validateApiKey(app.controlDb, tokenFromQuery);
            if (keyAuth) {
              auth = keyAuth;
            }
          } catch {
            // Fall through to anonymous
          }
        } else {
          // Assume JWT — check if it's an end-user JWT
          try {
            const decoded = JSON.parse(
              Buffer.from(tokenFromQuery.split('.')[1], 'base64').toString()
            );
            if (decoded.iss && decoded.iss.startsWith('butterbase:app:')) {
              auth = {
                userId: '',
                authMethod: 'end_user_jwt',
                scopes: [],
                rawToken: tokenFromQuery,
              } as any;
            }
          } catch {
            // Not a valid JWT — leave as anonymous
          }
        }
      }
    }
    // Ensure auth always has a value
    if (!auth) {
      auth = { userId: null, authMethod: 'anonymous', scopes: [] };
    }

    let dbName: string;
    let role: 'butterbase_anon' | 'butterbase_user' | 'butterbase_service';
    let userId: string | null;

    try {
      const resolved = await resolveRealtimeAuth(app.controlDb, app_id, auth);
      dbName = resolved.dbName;
      role = resolved.role;
      userId = resolved.userId;
    } catch (err) {
      const message = err instanceof AppPausedError
        ? `App is paused${err.reason ? `: ${err.reason}` : ''}`
        : err instanceof AppAuthRequiredError
          ? 'This app requires authentication. Anonymous access is disabled.'
          : err instanceof AppNotFoundError
            ? 'App not found'
            : 'Authentication failed';
      socket.send(JSON.stringify({ type: 'error', message }));
      const closeReason = err instanceof AppPausedError
        ? 'App paused'
        : err instanceof AppAuthRequiredError
          ? 'Auth required'
          : 'Auth failed';
      // 1013 = Try again later (matches the 503/Retry-After semantics on HTTP routes)
      const closeCode = err instanceof AppPausedError ? 1013 : 1008;
      socket.close(closeCode, closeReason);
      return;
    }

    // Register with the realtime manager
    await app.realtimeManager.addClient(socket, app_id, dbName, userId, role);

    // Send welcome message
    socket.send(JSON.stringify({
      type: 'connected',
      app_id,
      role,
    }));

    // Handle incoming messages
    socket.on('message', (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      switch (msg.type) {
        case 'subscribe':
          if (msg.table && typeof msg.table === 'string') {
            const filter = msg.filter && typeof msg.filter === 'object' && !Array.isArray(msg.filter)
              ? msg.filter as Record<string, unknown>
              : null;
            app.realtimeManager.subscribe(socket, msg.table, filter);
          } else {
            socket.send(JSON.stringify({ type: 'error', message: 'Missing "table" field' }));
          }
          break;

        case 'unsubscribe':
          if (msg.table && typeof msg.table === 'string') {
            app.realtimeManager.unsubscribe(socket, msg.table);
          } else {
            socket.send(JSON.stringify({ type: 'error', message: 'Missing "table" field' }));
          }
          break;

        case 'presence_track': {
          const metadata = (msg.metadata && typeof msg.metadata === 'object')
            ? msg.metadata as Record<string, unknown>
            : {};
          app.realtimeManager.trackPresence(socket, metadata);
          break;
        }

        case 'presence_update': {
          const metadata = (msg.metadata && typeof msg.metadata === 'object')
            ? msg.metadata as Record<string, unknown>
            : {};
          app.realtimeManager.updatePresence(socket, metadata);
          break;
        }

        case 'event': {
          const eventName = typeof msg.event === 'string' ? msg.event : null;
          if (!eventName) {
            socket.send(JSON.stringify({ type: 'error', message: 'Missing "event" field' }));
            break;
          }
          handleWebSocketEvent(app, app_id, userId, eventName, msg.payload, socket);
          break;
        }

        default:
          socket.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
      }
    });

    // Cleanup on disconnect
    socket.on('close', () => {
      app.realtimeManager.removeClient(socket);
    });
  });

  // --------------------------------------------------------------------------
  // REST: Configure realtime on tables
  // POST /v1/:app_id/realtime/configure
  // --------------------------------------------------------------------------

  app.post('/v1/:app_id/realtime/configure', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const { tables } = request.body as { tables: string[] };

    if (!tables || !Array.isArray(tables) || tables.length === 0) {
      return reply.code(400).send(createAgentError({
        code: 'VALIDATION_MISSING_FIELD',
        message: 'Request body must include a non-empty "tables" array',
        remediation: 'Provide { "tables": ["table1", "table2"] }',
        documentation_url: getDocUrl('VALIDATION_MISSING_FIELD'),
      }));
    }

    try {
      // Only app owners (API key or platform JWT) can configure realtime
      if (request.auth.authMethod === 'end_user_jwt' || request.auth.authMethod === 'anonymous') {
        return reply.code(403).send(createAgentError({
          code: 'AUTH_INSUFFICIENT_PERMISSIONS',
          message: 'Only app owners can configure realtime. Use an API key or platform JWT.',
          remediation: 'Authenticate with your Butterbase API key (bb_sk_...) instead of an end-user JWT.',
          documentation_url: getDocUrl('AUTH_INSUFFICIENT_PERMISSIONS'),
        }));
      }

      // Resolve app + verify ownership
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, request.auth.userId!);

      const pool = await getAppPoolForApp(app.controlDb, resolvedApp.id, resolvedApp.db_name);

      // Validate that all tables exist
      const schema = await introspectSchema(pool);
      const missing = tables.filter((t) => !schema.tables[t]);
      if (missing.length > 0) {
        return reply.code(404).send(createAgentError({
          code: VALIDATION_TABLE_NOT_FOUND,
          message: `Tables not found: ${missing.join(', ')}`,
          remediation: 'Create the tables first using apply_schema, then configure realtime.',
          documentation_url: getDocUrl(VALIDATION_TABLE_NOT_FOUND),
          details: { missing_tables: missing },
        }));
      }

      // Enable triggers on each table in the app DB
      const results: Array<{ table: string; status: string }> = [];
      for (const table of tables) {
        await pool.query('SELECT realtime.enable_table_trigger($1)', [table]);

        // Record in runtime DB
        await (await runtimeDbForApp(app_id)).query(
          `INSERT INTO app_realtime_config (app_id, table_name, enabled)
           VALUES ($1, $2, TRUE)
           ON CONFLICT (app_id, table_name)
           DO UPDATE SET enabled = TRUE, updated_at = NOW()`,
          [app_id, table]
        );

        results.push({ table, status: 'enabled' });
      }

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'realtime.configure',
        action: 'enable',
        resourceType: 'realtime',
        eventData: { tables, enabled_count: results.length },
        success: true,
      });

      return { configured: results };
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
        }));
      }
      throw error;
    }
  });

  // --------------------------------------------------------------------------
  // REST: Get realtime config
  // GET /v1/:app_id/realtime/config
  // --------------------------------------------------------------------------

  app.get('/v1/:app_id/realtime/config', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    try {
      // Resolve app
      if (request.auth.authMethod === 'api_key' || request.auth.authMethod === 'jwt') {
        await AppResolver.resolveApp(app.controlDb, app_id, request.auth.userId!);
      } else {
        await AppResolver.resolveAppPublic(app.controlDb, app_id);
      }

      const result = await (await runtimeDbForApp(app_id)).query<{
        table_name: string;
        events: string[];
        enabled: boolean;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT table_name, events, enabled, created_at, updated_at
         FROM app_realtime_config
         WHERE app_id = $1
         ORDER BY table_name`,
        [app_id]
      );

      // Cross-check the control-plane registration against the actual
      // app-DB trigger state. The two can drift when a table is
      // dropped/recreated by a schema apply (which takes the trigger
      // with it) — without this check, the dashboard claims realtime
      // is enabled while no events ever flow. Best-effort: if we can't
      // reach the app DB, return the control-plane view alone.
      let triggerStatus = new Map<string, boolean>();
      if (result.rows.length > 0) {
        try {
          const appRow = await (await runtimeDbForApp(app_id)).query<{ db_name: string }>(
            'SELECT db_name FROM apps WHERE id = $1',
            [app_id]
          );
          const dbName = appRow.rows[0]?.db_name;
          if (dbName) {
            const pool = await getAppPoolForApp(app.controlDb, app_id, dbName);
            const triggerNames = result.rows.map(
              (r) => `trg_realtime_${r.table_name.replace(/\./g, '_')}`
            );
            const trg = await pool.query<{ tgname: string }>(
              `SELECT tgname FROM pg_trigger WHERE tgname = ANY($1::text[])`,
              [triggerNames]
            );
            const installed = new Set(trg.rows.map((r) => r.tgname));
            for (const r of result.rows) {
              const expected = `trg_realtime_${r.table_name.replace(/\./g, '_')}`;
              triggerStatus.set(r.table_name, installed.has(expected));
            }
          }
        } catch {
          triggerStatus = new Map();
        }
      }

      const tables = result.rows.map((r) => {
        const installed = triggerStatus.get(r.table_name);
        return {
          ...r,
          // undefined = couldn't check (older app or app DB unreachable);
          // true/false = ground truth.
          trigger_installed: installed,
          drift: r.enabled && installed === false,
        };
      });

      // active_connection is true if ANY control-api instance is currently
      // holding a LISTEN connection for this app. Each instance writes a
      // TTL'd Redis presence key while it has a local listener and refreshes
      // it; hasActiveListener() does a SCAN over those per-instance keys.
      // Pub/sub state (NUMSUB) was unreliable on Upstash because pub/sub and
      // command routing can split — explicit presence keys avoid that.
      const activeConnection = await app.realtimeManager.hasActiveListener(app_id);

      const wsUrl = config.apiBaseUrl.replace(/^http/, 'ws') + `/v1/${app_id}/realtime`;
      return {
        app_id,
        tables,
        active_connection: activeConnection,
        websocket_url: wsUrl,
      };
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
        }));
      }
      throw error;
    }
  });

  // --------------------------------------------------------------------------
  // REST: Disable realtime on a table
  // DELETE /v1/:app_id/realtime/:table_name
  // --------------------------------------------------------------------------

  app.delete('/v1/:app_id/realtime/:table_name', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { app_id, table_name } = request.params as { app_id: string; table_name: string };

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, request.auth.userId!);
      const pool = await getAppPoolForApp(app.controlDb, resolvedApp.id, resolvedApp.db_name);

      // Disable the trigger in the app DB
      await pool.query('SELECT realtime.disable_table_trigger($1)', [table_name]);

      // Update runtime DB
      await (await runtimeDbForApp(app_id)).query(
        `UPDATE app_realtime_config SET enabled = FALSE, updated_at = NOW()
         WHERE app_id = $1 AND table_name = $2`,
        [app_id, table_name]
      );

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'realtime.disable',
        action: 'disable',
        resourceType: 'realtime',
        resourceId: table_name,
        eventData: { table: table_name },
        success: true,
      });

      return { table: table_name, status: 'disabled' };
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
        }));
      }
      throw error;
    }
  });
}
