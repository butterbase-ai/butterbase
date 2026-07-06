import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';
import { getAppPoolForApp } from '../services/app-pool.js';
import { introspectSchema } from '../services/schema-introspector.js';
import { buildSelectQuery } from '../services/query-builder.js';
import { AppResolver, AppNotFoundError, AppAuthRequiredError, AppPausedError, assertAppNotPaused } from '../services/app-resolver.js';
import { verifyEndUserJwt } from '../services/end-user-auth.js';
import { ApiKeyService } from '../services/api-key-service.js';
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
import { logAuditEventFromControlDb } from '../services/audit/audit-events-service.js';
import { decrypt } from '../services/crypto.js';
import { verifyStripe, verifyGithub, verifyCustomHmac } from '../services/webhook-verifiers.js';
import { getRedisClient } from '../services/redis.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WebhookInvocationStatus = 'completed' | 'rejected' | 'skipped_duplicate';

async function recordWebhookInvocation(
  runtimeDb: Pool,
  args: {
    functionId: string;
    appId: string;
    status: WebhookInvocationStatus;
    statusCode: number;
    durationMs?: number;
    startedAt?: Date;
    errorMessage?: string | null;
    sourceEventId?: string | null;
  },
): Promise<void> {
  try {
    await runtimeDb.query(
      `INSERT INTO function_invocations
        (function_id, app_id, method, path, status_code, duration_ms,
         error_message, started_at, completed_at, trigger_type, status, source_event_id)
       VALUES ($1, $2, 'POST', $3, $4, $5, $6, $7, now(), 'webhook', $8, $9)
       ON CONFLICT (function_id, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING`,
      [
        args.functionId, args.appId,
        `/webhook/${args.functionId}`, args.statusCode,
        args.durationMs ?? 0, args.errorMessage ?? null,
        args.startedAt ?? new Date(), args.status,
        args.sourceEventId ?? null,
      ],
    );
  } catch (err) {
    console.warn('failed to record webhook invocation', err);
  }
}

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
    const resolvedApp = await AppResolver.resolveApp(controlDb, appId, auth.userId!, auth.organizationId ?? null);
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
  // WEBHOOK TRIGGER ROUTE — scoped so the raw-body parser only applies here.
  // Signature verification (Stripe/GitHub/HMAC) needs the exact bytes the
  // caller sent; Fastify's default JSON parser would re-serialize and break
  // the HMAC.
  app.register(async function webhookScope(scope) {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    scope.post('/v1/:appId/webhook/:functionName', {
      config: { public: true, requiresAppRegion: true, migrationGuard: true },
    }, async (request, reply) => {
      const { appId, functionName } = request.params as { appId: string; functionName: string };
      const rawBody: Buffer = request.body instanceof Buffer ? request.body : Buffer.from('');
      const runtimeDb = await getRuntimeDbForApp(app.controlDb, appId);

      // 1. Paused kill-switch + function/trigger lookup in one query.
      const lookup = await runtimeDb.query<{
        paused: boolean;
        paused_reason: string | null;
        function_id: string | null;
        trigger_config: {
          provider: 'stripe' | 'github' | 'custom';
          secret: string;
          signature_header?: string;
          tolerance_seconds?: number;
          idempotency_key_header?: string;
        } | null;
      }>(
        `SELECT a.paused, a.paused_reason,
                f.id AS function_id,
                ft.trigger_config
         FROM apps a
         LEFT JOIN app_functions f ON f.app_id = a.id AND f.name = $2 AND f.deleted_at IS NULL
         LEFT JOIN function_triggers ft ON ft.function_id = f.id
           AND ft.trigger_type = 'webhook' AND ft.enabled = true
         WHERE a.id = $1`,
        [appId, functionName],
      );
      const meta = lookup.rows[0];
      if (meta?.paused) {
        return pausedReply(reply, new AppPausedError(appId, meta.paused_reason ?? null));
      }
      if (!meta?.function_id || !meta.trigger_config) {
        return reply.status(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'Webhook function not found',
          remediation: 'Verify the function name and that it has a webhook trigger.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
        }));
      }
      const functionId = meta.function_id;
      const cfg = meta.trigger_config;

      // 2. Idempotency dedupe (best-effort) — if the trigger config names a
      // header, SETNX on Redis with a 24h TTL; duplicates short-circuit.
      let sourceEventId: string | null = null;
      if (cfg.idempotency_key_header) {
        const key = request.headers[cfg.idempotency_key_header.toLowerCase()];
        if (typeof key === 'string' && key.length > 0) {
          sourceEventId = key;
          try {
            const redis = getRedisClient();
            const redisKey = `webhook:idemp:${functionId}:${key}`;
            const setResult = await redis.set(redisKey, '1', 'EX', 60 * 60 * 24, 'NX');
            if (setResult === null) {
              await recordWebhookInvocation(runtimeDb, {
                functionId, appId,
                status: 'skipped_duplicate',
                statusCode: 200,
                sourceEventId,
              });
              request.log.info({ scope: 'webhook', appId, functionName, source_event_id: sourceEventId }, 'webhook duplicate dropped');
              return reply
                .status(200)
                .header('x-butterbase-duplicate', 'true')
                .send({ ok: true, duplicate: true });
            }
          } catch (err) {
            // Redis down — proceed without dedupe, but log it.
            request.log.warn({ err, appId, functionName }, 'webhook idempotency dedupe failed, proceeding without it');
          }
        }
      }

      // 3. Decrypt the stored secret.
      let secret: string;
      try {
        secret = decrypt(cfg.secret, process.env.AUTH_ENCRYPTION_KEY!);
      } catch (err) {
        request.log.error({ err, appId, functionName }, 'webhook secret decryption failed');
        return reply.status(500).send({ error: 'webhook configuration invalid' });
      }

      // 4. Verify signature based on provider.
      let verifyResult;
      if (cfg.provider === 'stripe') {
        verifyResult = verifyStripe(
          rawBody,
          request.headers['stripe-signature'] as string | undefined,
          secret,
          cfg.tolerance_seconds ?? 300,
        );
      } else if (cfg.provider === 'github') {
        verifyResult = verifyGithub(
          rawBody,
          request.headers['x-hub-signature-256'] as string | undefined,
          secret,
        );
      } else {
        const headerName = (cfg.signature_header ?? 'x-signature').toLowerCase();
        verifyResult = verifyCustomHmac(
          rawBody,
          request.headers[headerName] as string | undefined,
          secret,
        );
      }

      if (!verifyResult.ok) {
        await recordWebhookInvocation(runtimeDb, {
          functionId, appId,
          status: 'rejected',
          errorMessage: `signature verification failed: ${verifyResult.reason}`,
          statusCode: 401,
          sourceEventId,
        });
        request.log.info({ scope: 'webhook', appId, functionName, provider: cfg.provider, reason: verifyResult.reason }, 'webhook signature rejected');
        return reply.status(401).send({ error: 'signature verification failed' });
      }

      // 5. Forward to Deno runtime.
      const startedAt = new Date();
      const startTime = Date.now();
      const runtimeResponse = await fetch(
        `${config.runtimeUrl}/execute/${appId}/${functionName}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': (request.headers['content-type'] as string | undefined) ?? 'application/json',
            'x-app-id': appId,
            'x-trigger-type': 'webhook',
            'x-webhook-provider': cfg.provider,
          },
          body: rawBody as BodyInit,
        },
      );
      const durationMs = Date.now() - startTime;
      const responseBody = await runtimeResponse.text();

      // 6. Record invocation.
      await recordWebhookInvocation(runtimeDb, {
        functionId, appId,
        status: 'completed',
        statusCode: runtimeResponse.status,
        durationMs,
        startedAt,
        errorMessage: runtimeResponse.ok ? null : responseBody.slice(0, 4000),
        sourceEventId,
      });
      request.log.info({
        scope: 'webhook', appId, functionName, provider: cfg.provider,
        status_code: runtimeResponse.status, duration_ms: durationMs,
      }, 'webhook forwarded');

      return reply
        .status(runtimeResponse.status)
        .header('content-type', runtimeResponse.headers.get('content-type') ?? 'application/json')
        .send(responseBody);
    });
  });

  // FUNCTION EXECUTION — ALL /v1/:app_id/fn/:functionName
  app.all('/v1/:app_id/fn/:functionName', {
    config: { public: true, requiresAppRegion: true, migrationGuard: true }
  }, async (request, reply) => {
    const { app_id, functionName } = request.params as { app_id: string; functionName: string };
    let userId: string | undefined;

    try {
      // Pause kill-switch + per-function HTTP-trigger auth lookup in one
      // round-trip. Reads from the app's home runtime DB (apps,
      // app_functions, and function_triggers all live there together).
      // Joining ONLY the HTTP trigger means non-HTTP-trigger functions show
      // `trigger_config IS NULL` here, which short-circuits the auth check
      // below — preserves pre-cutover behavior where `trigger_type !== 'http'`
      // skipped the check.
      const runtimeDb = await getRuntimeDbForApp(app.controlDb, app_id);
      const metaCheck = await runtimeDb.query<{
        paused: boolean;
        paused_reason: string | null;
        trigger_config: { auth?: 'required' | 'optional' | 'none' } | null;
        allow_service_key_impersonation: boolean | null;
      }>(
        `SELECT a.paused, a.paused_reason, ft.trigger_config,
                f.allow_service_key_impersonation
         FROM apps a
         LEFT JOIN app_functions f
           ON f.app_id = a.id AND f.name = $2 AND f.deleted_at IS NULL
         LEFT JOIN function_triggers ft
           ON ft.function_id = f.id AND ft.trigger_type = 'http' AND ft.enabled
         WHERE a.id = $1`,
        [app_id, functionName]
      );
      const meta = metaCheck.rows[0];
      if (meta?.paused) {
        throw new AppPausedError(app_id, meta.paused_reason ?? null);
      }

      // Extract caller identity. Two paths:
      //   1) Bearer is a bb_sk_* service key — validate and surface key_id +
      //      scopes to the runtime. This is the path cron / cross-fn callers
      //      take, and it's what `ctx.caller` exposes in the runtime so user
      //      code doesn't have to do its own bearer comparisons.
      //   2) Bearer is an end-user JWT — verify and surface user id.
      // The two paths are mutually exclusive on a single request, so try the
      // cheap shape check (bb_sk_* prefix) before the expensive JWT verify.
      const authHeader = request.headers.authorization;
      let callerType: 'service_key' | 'end_user_jwt' | 'loopback' | 'anonymous' = 'anonymous';
      let callerKeyId: string | null = null;
      let callerScope: string | null = null;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token.startsWith('bb_sk_')) {
          const auth = await ApiKeyService.validateApiKey(app.controlDb, token);
          if (auth) {
            callerType = 'service_key';
            callerKeyId = auth.keyId ?? null;
            // Pick the first app-scoped scope that names this app, if any.
            // Format on the wire is `app:<app_id>`; fall back to the literal
            // scope list if no app-scoped entry exists (lets ai:gateway-only
            // keys still surface SOMETHING in ctx.caller).
            const appScoped = auth.scopes?.find(s => s.startsWith('app:')) ?? null;
            callerScope = appScoped ?? auth.scopes?.[0] ?? null;
          } else {
            // Invalid / revoked bb_sk_* — leave as anonymous and let the
            // user function decide. Same posture as a missing bearer.
            app.log.warn({ app_id, functionName }, 'invalid bb_sk_* on function invocation');
          }
        } else if (/^[a-f0-9]{40,80}$/.test(token)) {
          // Phase 3: per-app internal function key (40–80 hex chars, no
          // prefix). Used by ctx.invoke for same-app function-to-function
          // calls — the runtime injected this key on the calling function's
          // ctx, so a valid match here implies "this app's runtime is
          // calling itself." Treat as `loopback`: equivalent trust to a
          // service key scoped to this app, but distinguishable in audit
          // logs and ctx.caller for downstream debugging.
          const { KvCredentialsService } = await import('../services/kv-credentials.js');
          const svc = new KvCredentialsService(app.controlDb);
          const resolved = await svc.resolveFunctionKeyWithOwner(token, app_id);
          if (resolved) {
            callerType = 'loopback';
            callerScope = `app:${app_id}`;
            // keyId stays null — function_keys aren't first-class api_keys
            // rows; we don't have a stable id to surface.
          } else {
            app.log.warn({ app_id, functionName }, 'unrecognized function_key on fn invocation');
          }
        } else {
          try {
            const claims = await verifyEndUserJwt(app.controlDb, app_id, token);
            userId = claims.sub;
            callerType = 'end_user_jwt';
          } catch (error) {
            app.log.warn({ error }, 'Invalid end-user JWT');
            // Continue without user ID - function can handle auth
          }
        }
      }

      // Enforce per-function auth requirement BEFORE forwarding to runtime.
      // Only acts when the HTTP trigger explicitly stores auth:'required' —
      // legacy deploys with empty config or auth:'none' keep existing
      // behavior. If the function row OR its http trigger is missing,
      // trigger_config is NULL and we fall through; let the runtime return
      // its own 404 / 405 so error semantics stay consistent.
      if (meta?.trigger_config?.auth === 'required' && !userId) {
        return reply.code(401).send(AUTH_REQUIRED_ERROR);
      }

      // Phase 2: service-key impersonation via `X-Butterbase-As-User`.
      //   - Header is honored ONLY when the caller is an app-scoped service
      //     key for THIS app (scope starts with `app:<app_id>`). Anonymous
      //     callers and end-user JWTs cannot impersonate — letting an end
      //     user claim to be another user is an obvious privilege break.
      //   - The target function must allow impersonation. The flag defaults
      //     to true (preserves the implicit pre-Phase-2 contract) and is
      //     flipped to false for admin/billing-webhook handlers.
      //   - When honored, the impersonated id wins over any user id we may
      //     have derived from an end-user JWT path (which isn't possible
      //     here anyway — service-key path doesn't set userId).
      const asUserHeader = request.headers['x-butterbase-as-user'];
      const asUser = typeof asUserHeader === 'string' ? asUserHeader.trim() : null;
      if (asUser) {
        // Phase 3: `loopback` calls (same-app ctx.invoke) are internally
        // trusted — the runtime authenticated with the per-app function
        // key, which only the platform-managed runtime holds. Accept them
        // the same as app-scoped service keys here.
        const isAppScopedServiceKey =
          callerType === 'service_key' && callerScope === `app:${app_id}`;
        const isLoopback = callerType === 'loopback';
        if (!isAppScopedServiceKey && !isLoopback) {
          return reply.code(403).send(createAgentError({
            code: 'AUTH_IMPERSONATION_FORBIDDEN',
            message: 'X-Butterbase-As-User requires an app-scoped service key',
            remediation: 'Send the request with a bb_sk_* key whose scope includes `app:<this app>`. End-user JWTs cannot impersonate other users.',
            documentation_url: getDocUrl('AUTH_IMPERSONATION_FORBIDDEN'),
          }));
        }
        // meta.allow_service_key_impersonation is null when the function row
        // or HTTP trigger is missing — same NULL path as trigger_config. In
        // that case we don't know whether impersonation is allowed; fall
        // through and let the runtime return its 404.
        if (meta?.allow_service_key_impersonation === false) {
          return reply.code(403).send(createAgentError({
            code: 'AUTH_IMPERSONATION_DISABLED',
            message: `Function ${functionName} does not accept service-key impersonation`,
            remediation: 'Enable impersonation via `manage_function` (allowServiceKeyImpersonation: true), or call the function with an end-user JWT instead of a service key + as-user header.',
            documentation_url: getDocUrl('AUTH_IMPERSONATION_DISABLED'),
          }));
        }
        userId = asUser;
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
        // Drop accept-encoding too: Deno's HTTP server honors it and would
        // pick zstd/br for the response, but undici's fetch here only
        // auto-decompresses gzip/deflate — anything else arrives as opaque
        // framed bytes that we'd then forward to the browser mis-labeled.
        if (
          lower === 'host' ||
          lower === 'connection' ||
          lower === 'transfer-encoding' ||
          lower === 'upgrade' ||
          lower === 'content-length' ||
          lower === 'content-encoding' ||
          lower === 'accept-encoding'
        ) continue;
        if (typeof value === 'string') forwardHeaders[lower] = value;
        else if (Array.isArray(value)) forwardHeaders[lower] = value[0];
      }
      // Terminate content-coding at this hop: ask the runtime for plaintext bytes.
      forwardHeaders['accept-encoding'] = 'identity';
      // Platform headers always override whatever the caller sent
      forwardHeaders['x-user-id'] = userId || '';
      forwardHeaders['x-app-id'] = app_id;
      // Caller identity (Phase 1: ctx.caller). Always set the type so the
      // runtime can normalize; key_id/scope only present for service-key
      // calls. Headers are platform-injected — anything the user sent under
      // these names was already overwritten by this assignment.
      forwardHeaders['x-butterbase-caller-type'] = callerType;
      if (callerKeyId) forwardHeaders['x-butterbase-caller-key-id'] = callerKeyId;
      if (callerScope) forwardHeaders['x-butterbase-caller-scope'] = callerScope;

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

      void logAuditEventFromControlDb(app.controlDb, {
        appId: app_id,
        category: 'function',
        eventType: 'function.invoke',
        action: 'invoke',
        resourceType: 'function',
        resourceId: functionName,
        // When a service key impersonates an end-user, attribute the action
        // to the key (not the impersonated user) so the audit trail shows
        // who actually invoked the request. The impersonated user lives in
        // event_data.impersonated_user_id alongside, queryable for
        // user-facing "what was done as me" surfaces.
        actorType: callerType === 'service_key' ? 'api_key' : (userId ? 'app_user' : 'anonymous'),
        actorId: callerType === 'service_key' ? (callerKeyId ?? null) : (userId ?? null),
        eventData: {
          duration_ms: durationMs,
          status_code: denoResponse.status,
          method: request.method,
          ...(asUser ? { impersonated_user_id: asUser } : {}),
        },
        ipAddress: request.ip ?? null,
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        success: denoResponse.ok,
      });

      // Streaming passthrough for SSE / chunked responses. Send via
      // reply.send(Readable.fromWeb(...)) rather than reply.hijack() so:
      //   - @fastify/cors's onSend hook still runs (CORS headers get injected)
      //   - Fastify's stream lifecycle destroys the source on client disconnect,
      //     which cancels the reader and closes our upstream to deno-runtime
      //     (preventing wasted upstream tokens on mid-stream aborts).
      const upstreamContentType = denoResponse.headers.get('content-type') ?? '';
      const isStream = upstreamContentType.toLowerCase().startsWith('text/event-stream');

      if (isStream && denoResponse.body) {
        for (const [key, value] of denoResponse.headers.entries()) {
          const lower = key.toLowerCase();
          // content-length collides with chunked transfer; content-encoding was
          // forced to identity upstream so nothing to propagate there either.
          if (lower === 'content-length' || lower === 'content-encoding') continue;
          reply.header(key, value);
        }
        reply.header('cache-control', 'no-cache, no-transform');
        reply.header('connection', 'keep-alive');
        reply.header('x-accel-buffering', 'no');
        return reply
          .status(denoResponse.status)
          .send(Readable.fromWeb(denoResponse.body as any));
      }

      // Non-streaming: buffer to preserve binary data.
      const responseBuffer = Buffer.from(await denoResponse.arrayBuffer());

      // Propagate upstream headers faithfully. We forced accept-encoding:identity
      // on the request above, so the runtime returns plaintext bytes and any
      // content-encoding it sets describes reality (not the previous behavior of
      // unconditionally claiming identity while passing through opaque zstd frames).
      // Skip content-length only — Fastify recomputes it from the outgoing buffer.
      for (const [key, value] of denoResponse.headers.entries()) {
        if (key.toLowerCase() !== 'content-length') {
          reply.header(key, value);
        }
      }

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

      void logAuditEventFromControlDb(app.controlDb, {
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
