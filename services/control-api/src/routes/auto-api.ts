import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { getAppPoolForApp } from '../services/app-pool.js';
import { introspectSchema } from '../services/schema-introspector.js';
import { buildSelectQuery } from '../services/query-builder.js';
import { AppResolver, AppNotFoundError, AppAuthRequiredError, AppPausedError, assertAppNotPaused } from '../services/app-resolver.js';
import { verifyEndUserJwt } from '../services/end-user-auth.js';
import type { EndUserClaims } from '@butterbase/shared/types';
import {
  createAgentError,
  getDocUrl,
  detectConstraintViolation,
  createConstraintViolationError,
  agentErrorFromEndUserJwtVerification,
  detectRlsViolation,
  detectInvalidInput,
  createInvalidInputError,
} from '../services/error-handler.js';
import { RESOURCE_NOT_FOUND, VALIDATION_TABLE_NOT_FOUND, VALIDATION_INVALID_SCHEMA, VALIDATION_INVALID_TYPE, APP_PAUSED } from '@butterbase/shared/error-types';
import { config } from '../config.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { logAuditEvent } from '../services/audit/audit-events-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AUTH_REQUIRED_ERROR = createAgentError({
  code: 'AUTH_REQUIRED',
  message: 'This app requires authentication. Anonymous access is disabled.',
  remediation: 'Send a valid end-user JWT in the Authorization header. Use magic-link or OAuth to obtain tokens.',
  documentation_url: getDocUrl('AUTH_REQUIRED'),
});

// Cache schema per app for short duration
const schemaCache = new Map<string, { schema: Awaited<ReturnType<typeof introspectSchema>>; expires: number }>();
const CACHE_TTL = 5000; // 5 seconds

async function getCachedSchema(appId: string, pool: Pool) {
  const cached = schemaCache.get(appId);
  if (cached && cached.expires > Date.now()) return cached.schema;

  const schema = await introspectSchema(pool);
  schemaCache.set(appId, { schema, expires: Date.now() + CACHE_TTL });
  return schema;
}

/**
 * Executes a query with role-based RLS context
 */
async function executeWithRole<T>(
  pool: Pool,
  role: 'butterbase_anon' | 'butterbase_user' | 'butterbase_service',
  userId: string | null,
  queryFn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Switch to non-privileged role so RLS is enforced
    // (connection role has BYPASSRLS on Neon, so RLS is skipped without this)
    await client.query(`SET LOCAL ROLE ${role}`);

    // Set GUC variables — policies and current_user_id() read from these
    await client.query(`SET LOCAL app.role = '${role}'`);

    // Set user ID for butterbase_user role
    if (role === 'butterbase_user' && userId) {
      await client.query(`SET LOCAL request.jwt.claim.sub = '${userId.replace(/'/g, "''")}'`);
    }

    const result = await queryFn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Resolves app, pool, and role based on auth method
 */
async function resolveAppAndPool(
  controlDb: Pool,
  appId: string,
  auth: any,
  headers?: Record<string, string | string[] | undefined>
): Promise<{ pool: Pool; role: 'butterbase_anon' | 'butterbase_user' | 'butterbase_service'; userId: string | null }> {
  if (auth.authMethod === 'end_user_jwt') {
    // Verify JWT
    const endUserClaims = await verifyEndUserJwt(controlDb, appId, auth.rawToken!);

    // Verify app exists and is provisioned
    const resolvedApp = await AppResolver.resolveAppPublic(controlDb, appId);
    assertAppNotPaused(resolvedApp);

    return {
      pool: await getAppPoolForApp(controlDb, resolvedApp.id, resolvedApp.db_name),
      role: 'butterbase_user',
      userId: endUserClaims.sub,
    };
  } else if (auth.authMethod === 'api_key' || auth.authMethod === 'jwt') {
    // Platform auth (API key or platform JWT)
    const resolvedApp = await AppResolver.resolveApp(controlDb, appId, auth.userId!);
    assertAppNotPaused(resolvedApp);
    const pool = await getAppPoolForApp(controlDb, resolvedApp.id, resolvedApp.db_name);

    // Role simulation: only allowed from platform auth (api_key/jwt)
    const asRole = headers?.['x-butterbase-as-role'] as string | undefined;
    const asUser = headers?.['x-butterbase-as-user'] as string | undefined;

    if (asRole === 'anon') {
      return { pool, role: 'butterbase_anon', userId: null };
    }
    if (asRole === 'user' && asUser) {
      return { pool, role: 'butterbase_user', userId: asUser };
    }

    return { pool, role: 'butterbase_service', userId: null };
  } else {
    // Anonymous access
    const resolvedApp = await AppResolver.resolveAppPublic(controlDb, appId);
    assertAppNotPaused(resolvedApp);

    if (resolvedApp.access_mode === 'authenticated') {
      throw new AppAuthRequiredError(appId);
    }

    return {
      pool: await getAppPoolForApp(controlDb, resolvedApp.id, resolvedApp.db_name),
      role: 'butterbase_anon',
      userId: null,
    };
  }
}

/**
 * Standard 503 reply for paused apps. Mirrors the AppAuthRequiredError → 401
 * pattern used elsewhere in this file.
 */
function pausedReply(reply: any, error: AppPausedError) {
  return reply.code(503)
    .header('Retry-After', '60')
    .send(createAgentError({
      code: APP_PAUSED,
      message: 'App is paused',
      remediation: error.reason
        ? `The app owner paused this app: "${error.reason}". Wait for it to be resumed, or contact the owner.`
        : 'The app owner paused this app. Wait for it to be resumed, or contact the owner.',
      documentation_url: getDocUrl(APP_PAUSED),
      details: { paused_reason: error.reason },
    }));
}

export async function autoApiRoutes(app: FastifyInstance) {
  // WEBHOOK TRIGGER ROUTE (PLACEHOLDER)
  app.post('/v1/:appId/webhook/:functionName', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { appId, functionName } = request.params as { appId: string; functionName: string };

    // TODO: Verify webhook signature if configured
    // TODO: Validate function exists and has webhook trigger
    // TODO: Forward to Deno runtime with webhook payload

    app.log.info({ appId, functionName }, '[PLACEHOLDER] Webhook received');

    return reply.status(501).send(createAgentError({
      code: 'STATE_INVALID_TRANSITION',
      message: 'Webhook triggers not yet implemented',
      remediation: 'This feature will be available in a future release. Use HTTP triggers for now.',
      documentation_url: getDocUrl('STATE_INVALID_TRANSITION'),
      details: { appId, functionName }
    }));
  });

  // FUNCTION EXECUTION — ALL /v1/:app_id/fn/:functionName
  app.all('/v1/:app_id/fn/:functionName', {
    config: { public: true, requiresAppRegion: true, migrationGuard: true }
  }, async (request, reply) => {
    const { app_id, functionName } = request.params as { app_id: string; functionName: string };
    let userId: string | undefined;

    try {
      // Pause kill-switch + per-function auth lookup in one round-trip.
      // Reads from the app's home runtime DB (apps + app_functions live together).
      const runtimeDb = await getRuntimeDbForApp(app.controlDb, app_id);
      const metaCheck = await runtimeDb.query<{
        paused: boolean;
        paused_reason: string | null;
        trigger_type: string | null;
        trigger_config: { auth?: 'required' | 'optional' | 'none' } | null;
      }>(
        `SELECT a.paused, a.paused_reason, f.trigger_type, f.trigger_config
         FROM apps a
         LEFT JOIN app_functions f
           ON f.app_id = a.id AND f.name = $2 AND f.deleted_at IS NULL
         WHERE a.id = $1`,
        [app_id, functionName]
      );
      const meta = metaCheck.rows[0];
      if (meta?.paused) {
        throw new AppPausedError(app_id, meta.paused_reason ?? null);
      }

      // Extract user ID from end-user JWT (if present)
      const authHeader = request.headers.authorization;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        try {
          // Verify end-user JWT
          const claims = await verifyEndUserJwt(app.controlDb, app_id, token);
          userId = claims.sub;
        } catch (error) {
          app.log.warn({ error }, 'Invalid end-user JWT');
          // Continue without user ID - function can handle auth
        }
      }

      // Enforce per-function auth requirement BEFORE forwarding to runtime.
      // Only acts when the function explicitly stores auth:'required' — legacy
      // deploys with empty config or auth:'none' keep existing behavior.
      // If the function row is missing here, fall through and let the runtime
      // return its own 404 so error semantics stay consistent.
      if (meta?.trigger_type === 'http'
          && meta.trigger_config?.auth === 'required'
          && !userId) {
        return reply.code(401).send(AUTH_REQUIRED_ERROR);
      }

      // Forward to Deno runtime (preserve query string)
      const queryString = request.raw.url?.includes('?')
        ? '?' + request.raw.url.split('?')[1]
        : '';
      const invokeStart = Date.now();

      // Forward all caller headers; drop hop-by-hop headers that must not be proxied
      const forwardHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        const lower = key.toLowerCase();
        // Drop hop-by-hop headers + headers that describe the original body bytes.
        // We may re-serialize the body below (JSON.stringify), and Fastify's parsers
        // may have already decoded any content-encoding, so the original
        // content-length / content-encoding no longer match what we send. Let
        // undici recompute content-length from the outgoing buffer.
        if (
          lower === 'host' ||
          lower === 'connection' ||
          lower === 'transfer-encoding' ||
          lower === 'upgrade' ||
          lower === 'content-length' ||
          lower === 'content-encoding'
        ) continue;
        if (typeof value === 'string') forwardHeaders[lower] = value;
        else if (Array.isArray(value)) forwardHeaders[lower] = value[0];
      }
      // Platform headers always override whatever the caller sent
      forwardHeaders['x-user-id'] = userId || '';
      forwardHeaders['x-app-id'] = app_id;

      // Forward the raw body without re-serialization:
      //   - Buffer: wildcard parser captured multipart / octet-stream / etc.
      //   - string: text/plain parsed by Fastify's default parser
      //   - object: application/json parsed by Fastify's default parser
      //   - null/undefined: GET/HEAD/DELETE with no body
      // Collect raw bytes without re-serialization. Buffer is a valid Node.js
      // fetch body at runtime; cast to BodyInit to satisfy TS 5.9 strict ArrayBuffer types.
      const rawBody: Buffer | undefined =
        request.body instanceof Buffer ? request.body
        : typeof request.body === 'string' ? Buffer.from(request.body)
        : request.body != null ? Buffer.from(JSON.stringify(request.body as object))
        : undefined;

      const denoResponse = await fetch(
        `${config.runtimeUrl}/execute/${app_id}/${functionName}${queryString}`,
        {
          method: request.method,
          headers: forwardHeaders,
          body: rawBody as BodyInit | undefined,
        }
      );
      const durationMs = Date.now() - invokeStart;

      void logAuditEvent(app.controlDb, {
        appId: app_id,
        category: 'function',
        eventType: 'function.invoke',
        action: 'invoke',
        resourceType: 'function',
        resourceId: functionName,
        actorType: userId ? 'app_user' : 'anonymous',
        actorId: userId ?? null,
        eventData: { duration_ms: durationMs, status_code: denoResponse.status, method: request.method },
        ipAddress: request.ip ?? null,
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        success: denoResponse.ok,
      });

      // Get response as buffer to preserve binary data
      const responseBuffer = Buffer.from(await denoResponse.arrayBuffer());

      // Set headers individually, excluding content-encoding to avoid conflicts
      for (const [key, value] of denoResponse.headers.entries()) {
        if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') {
          reply.header(key, value);
        }
      }

      // Disable Fastify's automatic compression for this response
      reply.header('content-encoding', 'identity');

      return reply
        .status(denoResponse.status)
        .send(responseBuffer);
    } catch (error) {
      if (error instanceof AppPausedError) {
        return pausedReply(reply, error);
      }

      // Classify undici fetch failures: timeouts mean the user function hung or
      // the runtime didn't respond in time → 504 + warn (not a platform bug).
      // Other fetch failures (DNS, refused connection, malformed body) → 502 + warn.
      // Anything else (synchronous throws inside this handler) → 500 + error.
      const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
      const causeName = cause instanceof Error ? cause.name : undefined;
      const isTimeout =
        causeName === 'HeadersTimeoutError' ||
        causeName === 'BodyTimeoutError' ||
        causeName === 'ConnectTimeoutError';
      const isFetchFailure = error instanceof TypeError && (error.message?.startsWith('fetch failed') ?? false);

      if (isTimeout || isFetchFailure) {
        app.log.warn({ err: error }, 'Function execution proxy failed');
      } else {
        app.log.error({ err: error }, 'Function execution error');
      }

      void logAuditEvent(app.controlDb, {
        appId: app_id,
        category: 'function',
        eventType: 'function.invoke',
        action: 'invoke',
        resourceType: 'function',
        resourceId: functionName,
        actorType: userId ? 'app_user' : 'anonymous',
        actorId: userId ?? null,
        eventData: { method: request.method },
        ipAddress: request.ip ?? null,
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      if (isTimeout) {
        return reply.status(504).send(createAgentError({
          code: 'FUNCTION_TIMEOUT',
          message: 'Function did not respond in time',
          remediation: 'The function exceeded the proxy timeout. Optimize long-running work or move it to a background task.',
          documentation_url: getDocUrl('FUNCTION_TIMEOUT'),
        }));
      }
      if (isFetchFailure) {
        return reply.status(502).send(createAgentError({
          code: 'EXTERNAL_NETWORK_ERROR',
          message: 'Function runtime unreachable',
          remediation: 'The Deno runtime did not respond. Retry shortly; if persistent, redeploy the function.',
          documentation_url: getDocUrl('EXTERNAL_NETWORK_ERROR'),
        }));
      }
      return reply.status(500).send(createAgentError({
        code: 'EXTERNAL_NETWORK_ERROR',
        message: 'Function execution failed',
        remediation: 'Check function logs for details. Verify the function is deployed and the Deno runtime is accessible.',
        documentation_url: getDocUrl('EXTERNAL_NETWORK_ERROR')
      }));
    }
  });

  // LIST — GET /v1/:app_id/:table
  app.get('/v1/:app_id/:table', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { app_id, table } = request.params as { app_id: string; table: string };
    if (table === 'schema') return; // handled by schemaRoutes

    try {
      const { pool, role, userId } = await resolveAppAndPool(
        app.controlDb,
        app_id,
        request.auth,
        request.headers
      );

      const schema = await getCachedSchema(app_id, pool);
      const tableDef = schema.tables[table];
      if (!tableDef) return reply.code(404).send(createAgentError({
        code: VALIDATION_TABLE_NOT_FOUND,
        message: `Table "${table}" not found`,
        remediation: `Create the table first using apply_schema. Example: {"tables": {"${table}": {"columns": {...}}}}`,
        documentation_url: getDocUrl(VALIDATION_TABLE_NOT_FOUND)
      }));

      const validColumns = new Set(Object.keys(tableDef.columns));
      const query = buildSelectQuery(table, validColumns, request.query as Record<string, string>);

      // Check for invalid filters
      if (query.invalidFilters && query.invalidFilters.length > 0) {
        return reply.code(400).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: 'Invalid query filters',
          remediation: `Fix the following filter errors:\n${query.invalidFilters.map(f => `  - ${f}`).join('\n')}\n\nUse get_schema to see available columns.`,
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
          details: { invalidFilters: query.invalidFilters }
        }));
      }

      // Execute query with role-based RLS
      const result = await executeWithRole(pool, role, userId, async (client) => {
        return client.query(query.text, query.values);
      });

      return result.rows;
    } catch (error) {
      if (error instanceof AppPausedError) {
        return pausedReply(reply, error);
      }
      if (error instanceof AppAuthRequiredError) {
        return reply.code(401).send(AUTH_REQUIRED_ERROR);
      }
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }

      // Check for constraint violations
      const constraintCheck = detectConstraintViolation(error);
      if (constraintCheck.isConstraint) {
        return reply.code(400).send(
          createConstraintViolationError(
            constraintCheck.constraintType!,
            constraintCheck.details!,
            { column: constraintCheck.column, tableName: constraintCheck.tableName }
          )
        );
      }

      // Check for RLS policy errors when using API key auth
      if (error instanceof Error && error.message.includes('current_user_id')) {
        return reply.code(403).send(createAgentError({
          code: 'AUTH_RLS_REQUIRES_USER_JWT',
          message: 'This table has Row-Level Security policies that require end-user authentication',
          remediation: 'Use an end-user JWT token instead of an API key. RLS policies that reference current_user_id() require authenticated user context.',
          documentation_url: getDocUrl('AUTH_RLS_REQUIRES_USER_JWT')
        }));
      }

      if (detectRlsViolation(error)) {
        return reply.code(403).send(createAgentError({
          code: 'AUTH_RLS_POLICY_VIOLATION',
          message: 'Access denied by row-level security policy',
          remediation: 'You do not have permission to perform this operation. You can only access or modify rows that belong to your user account.',
          documentation_url: getDocUrl('AUTH_RLS_POLICY_VIOLATION')
        }));
      }

      const endUserJwtErr = agentErrorFromEndUserJwtVerification(error);
      if (endUserJwtErr) {
        return reply.code(401).send(endUserJwtErr);
      }

      const invalidInput = detectInvalidInput(error);
      if (invalidInput.isInvalidInput) {
        return reply.code(400).send(createInvalidInputError(invalidInput.code!, invalidInput.detail));
      }

      const pgError = error as Error & { code?: string; detail?: string };
      app.log.error({ error }, 'Unhandled data-plane error');
      return reply.code(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: pgError.message || 'An unexpected database error occurred',
        remediation: 'An unexpected error occurred while processing your request. Verify your inputs are correct and retry.',
        details: pgError.code ? { pg_code: pgError.code, pg_detail: pgError.detail } : undefined,
      }));
    }
  });

  // GET BY ID — GET /v1/:app_id/:table/:id
  app.get('/v1/:app_id/:table/:id', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { app_id, table, id } = request.params as { app_id: string; table: string; id: string };

    if (!UUID_RE.test(id)) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_TYPE,
        message: `Invalid UUID format: "${id}"`,
        remediation: 'The id parameter must be a valid UUID (e.g. 550e8400-e29b-41d4-a716-446655440000).',
        documentation_url: getDocUrl(VALIDATION_INVALID_TYPE),
      }));
    }

    try {
      const { pool, role, userId } = await resolveAppAndPool(
        app.controlDb,
        app_id,
        request.auth,
        request.headers
      );

      const schema = await getCachedSchema(app_id, pool);
      const tableDef = schema.tables[table];
      if (!tableDef) return reply.code(404).send(createAgentError({
        code: VALIDATION_TABLE_NOT_FOUND,
        message: `Table "${table}" not found`,
        remediation: `Create the table first using apply_schema. Example: {"tables": {"${table}": {"columns": {...}}}}`,
        documentation_url: getDocUrl(VALIDATION_TABLE_NOT_FOUND)
      }));

      const result = await executeWithRole(pool, role, userId, async (client) => {
        return client.query(`SELECT * FROM "${table}" WHERE "id" = $1`, [id]);
      });

      if (result.rows.length === 0) return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Not found',
        remediation: 'Verify the ID is correct. The resource may not exist or you may not have permission to access it.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
      }));
      return result.rows[0];
    } catch (error) {
      if (error instanceof AppPausedError) {
        return pausedReply(reply, error);
      }
      if (error instanceof AppAuthRequiredError) {
        return reply.code(401).send(AUTH_REQUIRED_ERROR);
      }
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }

      // Check for constraint violations
      const constraintCheck = detectConstraintViolation(error);
      if (constraintCheck.isConstraint) {
        return reply.code(400).send(
          createConstraintViolationError(
            constraintCheck.constraintType!,
            constraintCheck.details!,
            { column: constraintCheck.column, tableName: constraintCheck.tableName }
          )
        );
      }

      // Check for RLS policy errors
      if (error instanceof Error && error.message.includes('current_user_id')) {
        return reply.code(403).send(createAgentError({
          code: 'AUTH_RLS_REQUIRES_USER_JWT',
          message: 'This table has Row-Level Security policies that require end-user authentication',
          remediation: 'Use an end-user JWT token instead of an API key. RLS policies that reference current_user_id() require authenticated user context.',
          documentation_url: getDocUrl('AUTH_RLS_REQUIRES_USER_JWT')
        }));
      }

      if (detectRlsViolation(error)) {
        return reply.code(403).send(createAgentError({
          code: 'AUTH_RLS_POLICY_VIOLATION',
          message: 'Access denied by row-level security policy',
          remediation: 'You do not have permission to perform this operation. You can only access or modify rows that belong to your user account.',
          documentation_url: getDocUrl('AUTH_RLS_POLICY_VIOLATION')
        }));
      }

      const endUserJwtErr = agentErrorFromEndUserJwtVerification(error);
      if (endUserJwtErr) {
        return reply.code(401).send(endUserJwtErr);
      }

      const invalidInput = detectInvalidInput(error);
      if (invalidInput.isInvalidInput) {
        return reply.code(400).send(createInvalidInputError(invalidInput.code!, invalidInput.detail));
      }

      const pgError = error as Error & { code?: string; detail?: string };
      app.log.error({ error }, 'Unhandled data-plane error');
      return reply.code(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: pgError.message || 'An unexpected database error occurred',
        remediation: 'An unexpected error occurred while processing your request. Verify your inputs are correct and retry.',
        details: pgError.code ? { pg_code: pgError.code, pg_detail: pgError.detail } : undefined,
      }));
    }
  });

  // INSERT — POST /v1/:app_id/:table
  app.post('/v1/:app_id/:table', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { app_id, table } = request.params as { app_id: string; table: string };

    try {
      const { pool, role, userId } = await resolveAppAndPool(
        app.controlDb,
        app_id,
        request.auth,
        request.headers
      );

      const schema = await getCachedSchema(app_id, pool);
      const tableDef = schema.tables[table];
      if (!tableDef) return reply.code(404).send(createAgentError({
        code: VALIDATION_TABLE_NOT_FOUND,
        message: `Table "${table}" not found`,
        remediation: `Create the table first using apply_schema. Example: {"tables": {"${table}": {"columns": {...}}}}`,
        documentation_url: getDocUrl(VALIDATION_TABLE_NOT_FOUND)
      }));

      const body = request.body as Record<string, unknown>;
      const validColumns = new Set(Object.keys(tableDef.columns));

      // Filter body to only valid columns
      const entries = Object.entries(body).filter(([k]) => validColumns.has(k));
      if (entries.length === 0) {
        return reply.code(400).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: 'No valid columns in request body',
          remediation: `Ensure your request body contains valid column names for table "${table}". Use get_schema to see available columns.`,
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA)
        }));
      }

      const columns = entries.map(([k]) => `"${k}"`).join(', ');
      const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ');
      const values = entries.map(([, v]) => v);

      const result = await executeWithRole(pool, role, userId, async (client) => {
        return client.query(
          `INSERT INTO "${table}" (${columns}) VALUES (${placeholders}) RETURNING *`,
          values
        );
      });

      return reply.code(201).send(result.rows[0]);
    } catch (error) {
      if (error instanceof AppPausedError) {
        return pausedReply(reply, error);
      }
      if (error instanceof AppAuthRequiredError) {
        return reply.code(401).send(AUTH_REQUIRED_ERROR);
      }
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }

      // Check for constraint violations
      const constraintCheck = detectConstraintViolation(error);
      if (constraintCheck.isConstraint) {
        return reply.code(400).send(
          createConstraintViolationError(
            constraintCheck.constraintType!,
            constraintCheck.details!,
            { column: constraintCheck.column, tableName: constraintCheck.tableName }
          )
        );
      }

      // Check for RLS policy errors when using API key auth
      if (error instanceof Error && error.message.includes('current_user_id')) {
        return reply.code(403).send(createAgentError({
          code: 'AUTH_RLS_REQUIRES_USER_JWT',
          message: 'This table has Row-Level Security policies that require end-user authentication',
          remediation: 'Use an end-user JWT token instead of an API key. RLS policies that reference current_user_id() require authenticated user context.',
          documentation_url: getDocUrl('AUTH_RLS_REQUIRES_USER_JWT')
        }));
      }

      if (detectRlsViolation(error)) {
        return reply.code(403).send(createAgentError({
          code: 'AUTH_RLS_POLICY_VIOLATION',
          message: 'Row-level security policy rejected this insert',
          remediation: 'If your table has a WITH CHECK policy (e.g. user_id = current_user_id()), ensure your request body includes that column with a value matching your authenticated user ID. Tip: use create_policy with user_column to auto-populate it, or use create_user_isolation_policy for the standard user-owns-row pattern.',
          documentation_url: getDocUrl('AUTH_RLS_POLICY_VIOLATION')
        }));
      }

      const endUserJwtErr = agentErrorFromEndUserJwtVerification(error);
      if (endUserJwtErr) {
        return reply.code(401).send(endUserJwtErr);
      }

      const invalidInput = detectInvalidInput(error);
      if (invalidInput.isInvalidInput) {
        return reply.code(400).send(createInvalidInputError(invalidInput.code!, invalidInput.detail));
      }

      const pgError = error as Error & { code?: string; detail?: string };
      app.log.error({ error }, 'Unhandled data-plane error');
      return reply.code(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: pgError.message || 'An unexpected database error occurred',
        remediation: 'An unexpected error occurred while processing your request. Verify your inputs are correct and retry.',
        details: pgError.code ? { pg_code: pgError.code, pg_detail: pgError.detail } : undefined,
      }));
    }
  });

  // UPDATE — PATCH /v1/:app_id/:table/:id
  app.patch('/v1/:app_id/:table/:id', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { app_id, table, id } = request.params as { app_id: string; table: string; id: string };

    if (!UUID_RE.test(id)) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_TYPE,
        message: `Invalid UUID format: "${id}"`,
        remediation: 'The id parameter must be a valid UUID (e.g., 550e8400-e29b-41d4-a716-446655440000).',
        documentation_url: getDocUrl(VALIDATION_INVALID_TYPE),
      }));
    }

    try {
      const { pool, role, userId } = await resolveAppAndPool(
        app.controlDb,
        app_id,
        request.auth,
        request.headers
      );

      const schema = await getCachedSchema(app_id, pool);
      const tableDef = schema.tables[table];
      if (!tableDef) return reply.code(404).send(createAgentError({
        code: VALIDATION_TABLE_NOT_FOUND,
        message: `Table "${table}" not found`,
        remediation: `Create the table first using apply_schema. Example: {"tables": {"${table}": {"columns": {...}}}}`,
        documentation_url: getDocUrl(VALIDATION_TABLE_NOT_FOUND)
      }));

      const body = request.body as Record<string, unknown>;
      const validColumns = new Set(Object.keys(tableDef.columns));

      const entries = Object.entries(body).filter(([k]) => validColumns.has(k));
      if (entries.length === 0) {
        return reply.code(400).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: 'No valid columns in request body',
          remediation: `Ensure your request body contains valid column names for table "${table}". Use get_schema to see available columns.`,
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA)
        }));
      }

      const setClauses = entries.map(([k], i) => `"${k}" = $${i + 1}`).join(', ');
      const values = [...entries.map(([, v]) => v), id];

      const result = await executeWithRole(pool, role, userId, async (client) => {
        return client.query(
          `UPDATE "${table}" SET ${setClauses} WHERE "id" = $${values.length} RETURNING *`,
          values
        );
      });

      if (result.rows.length === 0) return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Not found',
        remediation: 'Verify the ID is correct. The resource may not exist or you may not have permission to access it.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
      }));
      return result.rows[0];
    } catch (error) {
      if (error instanceof AppPausedError) {
        return pausedReply(reply, error);
      }
      if (error instanceof AppAuthRequiredError) {
        return reply.code(401).send(AUTH_REQUIRED_ERROR);
      }
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }

      // Check for constraint violations
      const constraintCheck = detectConstraintViolation(error);
      if (constraintCheck.isConstraint) {
        return reply.code(400).send(
          createConstraintViolationError(
            constraintCheck.constraintType!,
            constraintCheck.details!,
            { column: constraintCheck.column, tableName: constraintCheck.tableName }
          )
        );
      }

      // Check for RLS policy errors when using API key auth
      if (error instanceof Error && error.message.includes('current_user_id')) {
        return reply.code(403).send(createAgentError({
          code: 'AUTH_RLS_REQUIRES_USER_JWT',
          message: 'This table has Row-Level Security policies that require end-user authentication',
          remediation: 'Use an end-user JWT token instead of an API key. RLS policies that reference current_user_id() require authenticated user context.',
          documentation_url: getDocUrl('AUTH_RLS_REQUIRES_USER_JWT')
        }));
      }

      if (detectRlsViolation(error)) {
        return reply.code(403).send(createAgentError({
          code: 'AUTH_RLS_POLICY_VIOLATION',
          message: 'Access denied by row-level security policy',
          remediation: 'You do not have permission to perform this operation. You can only access or modify rows that belong to your user account.',
          documentation_url: getDocUrl('AUTH_RLS_POLICY_VIOLATION')
        }));
      }

      const endUserJwtErr = agentErrorFromEndUserJwtVerification(error);
      if (endUserJwtErr) {
        return reply.code(401).send(endUserJwtErr);
      }

      const invalidInput = detectInvalidInput(error);
      if (invalidInput.isInvalidInput) {
        return reply.code(400).send(createInvalidInputError(invalidInput.code!, invalidInput.detail));
      }

      const pgError = error as Error & { code?: string; detail?: string };
      app.log.error({ error }, 'Unhandled data-plane error');
      return reply.code(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: pgError.message || 'An unexpected database error occurred',
        remediation: 'An unexpected error occurred while processing your request. Verify your inputs are correct and retry.',
        details: pgError.code ? { pg_code: pgError.code, pg_detail: pgError.detail } : undefined,
      }));
    }
  });

  // DELETE — DELETE /v1/:app_id/:table/:id
  app.delete('/v1/:app_id/:table/:id', { config: { requiresAppRegion: true, migrationGuard: true } }, async (request, reply) => {
    const { app_id, table, id } = request.params as { app_id: string; table: string; id: string };

    if (!UUID_RE.test(id)) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_TYPE,
        message: `Invalid UUID format: "${id}"`,
        remediation: 'The id parameter must be a valid UUID (e.g., 550e8400-e29b-41d4-a716-446655440000).',
        documentation_url: getDocUrl(VALIDATION_INVALID_TYPE),
      }));
    }

    try {
      const { pool, role, userId } = await resolveAppAndPool(
        app.controlDb,
        app_id,
        request.auth,
        request.headers
      );

      const schema = await getCachedSchema(app_id, pool);
      const tableDef = schema.tables[table];
      if (!tableDef) return reply.code(404).send(createAgentError({
        code: VALIDATION_TABLE_NOT_FOUND,
        message: `Table "${table}" not found`,
        remediation: `Create the table first using apply_schema. Example: {"tables": {"${table}": {"columns": {...}}}}`,
        documentation_url: getDocUrl(VALIDATION_TABLE_NOT_FOUND)
      }));

      const result = await executeWithRole(pool, role, userId, async (client) => {
        return client.query(`DELETE FROM "${table}" WHERE "id" = $1`, [id]);
      });

      if (result.rowCount === 0) return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Not found',
        remediation: 'Verify the ID is correct. The resource may not exist or you may not have permission to delete it.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
      }));
      return { deleted: true };
    } catch (error) {
      if (error instanceof AppPausedError) {
        return pausedReply(reply, error);
      }
      if (error instanceof AppAuthRequiredError) {
        return reply.code(401).send(AUTH_REQUIRED_ERROR);
      }
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }

      // Check for constraint violations
      const constraintCheck = detectConstraintViolation(error);
      if (constraintCheck.isConstraint) {
        return reply.code(400).send(
          createConstraintViolationError(
            constraintCheck.constraintType!,
            constraintCheck.details!,
            { column: constraintCheck.column, tableName: constraintCheck.tableName }
          )
        );
      }

      // Check for RLS policy errors
      if (error instanceof Error && error.message.includes('current_user_id')) {
        return reply.code(403).send(createAgentError({
          code: 'AUTH_RLS_REQUIRES_USER_JWT',
          message: 'This table has Row-Level Security policies that require end-user authentication',
          remediation: 'Use an end-user JWT token instead of an API key. RLS policies that reference current_user_id() require authenticated user context.',
          documentation_url: getDocUrl('AUTH_RLS_REQUIRES_USER_JWT')
        }));
      }

      if (detectRlsViolation(error)) {
        return reply.code(403).send(createAgentError({
          code: 'AUTH_RLS_POLICY_VIOLATION',
          message: 'Access denied by row-level security policy',
          remediation: 'You do not have permission to perform this operation. You can only access or modify rows that belong to your user account.',
          documentation_url: getDocUrl('AUTH_RLS_POLICY_VIOLATION')
        }));
      }

      const endUserJwtErr = agentErrorFromEndUserJwtVerification(error);
      if (endUserJwtErr) {
        return reply.code(401).send(endUserJwtErr);
      }

      const invalidInput = detectInvalidInput(error);
      if (invalidInput.isInvalidInput) {
        return reply.code(400).send(createInvalidInputError(invalidInput.code!, invalidInput.detail));
      }

      const pgError = error as Error & { code?: string; detail?: string };
      app.log.error({ error }, 'Unhandled data-plane error');
      return reply.code(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: pgError.message || 'An unexpected database error occurred',
        remediation: 'An unexpected error occurred while processing your request. Verify your inputs are correct and retry.',
        details: pgError.code ? { pg_code: pgError.code, pg_detail: pgError.detail } : undefined,
      }));
    }
  });
}
