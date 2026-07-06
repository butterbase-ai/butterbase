// Derive BUTTERBASE_REGION from FLY_REGION using the env-supplied map.
// BUTTERBASE_FLY_REGION_MAP format: "<fly_code_a>:<region_a>,<fly_code_b>:<region_b>".
// No region identifiers are hardcoded in source. Matches the resolution order
// used by @butterbase/shared's loadRegionConfig() so direct readers of
// process.env.BUTTERBASE_REGION (e.g. route handlers) see the derived value.
if (
  !process.env.BUTTERBASE_REGION &&
  process.env.FLY_REGION &&
  process.env.BUTTERBASE_FLY_REGION_MAP
) {
  const map = Object.fromEntries(
    process.env.BUTTERBASE_FLY_REGION_MAP.split(',').map((pair) =>
      pair.split(':').map((s) => s.trim()),
    ),
  );
  const mapped = map[process.env.FLY_REGION];
  if (mapped) process.env.BUTTERBASE_REGION = mapped;
}

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import * as Sentry from '@sentry/node';
import { databasePlugin } from './plugins/database.js';
import runtimeDatabasePlugin from './plugins/runtime-database.js';
import { dataPlanePlugin } from './plugins/data-plane.js';
import corsPlugin from './plugins/cors.js';
import authPlugin from './plugins/auth.js';
import internalAuthPlugin from './plugins/internal-auth.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import quotaEnforcementPlugin from './plugins/quota-enforcement.js';
import flyReplayPlugin from './plugins/fly-replay.js';
import migrationGuardPlugin from './plugins/migration-guard.js';
import { healthRoutes } from './routes/health.js';
import { initRoutes } from './routes/init.js';
import { schemaRoutes } from './routes/schema.js';
import { autoApiRoutes } from './routes/auto-api.js';
import { rlsRoutes } from './routes/rls.js';
import { oauthConfigRoutes } from './routes/oauth-config.js';
import { auditLogRoutes } from './routes/audit-logs.js';
import { mcpRoutes } from './routes/mcp.js';
import { wellKnownRoutes } from './routes/well-known.js';
import { oauthRoutes } from './routes/oauth.js';
import { storageRoutes } from './routes/storage.js';
import { appConfigRoutes } from './routes/app-config.js';
import { cloneWebhookConfigRoutes } from './routes/clone-webhook-config.js';
import { repoRoutes } from './routes/repo.js';
import { cloneRoutes } from './routes/clone.js';
import { cloneRoutesPreflight } from './routes/clone-preflight.js';
import { templatesDiscoveryRoutes } from './routes/templates-discovery.js';
import { registerFunctionRoutes } from './routes/functions.js';
import { registerAppEnvRoutes } from './routes/app-env.js';
import { registerFrontendRoutes } from './routes/frontend.js';
import { registerEdgeSsrRoutes } from './routes/edge-ssr.js';
import { registerEdgeSsrFromSourceRoutes } from './routes/edge-ssr-from-source.js';
import { registerFrontendFromSourceRoutes } from './routes/frontend-from-source.js';
import { registerDurableObjectRoutes } from './routes/durable-objects.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { agentsRoutes } from './routes/agents.js';
import { agentPublicRoutes } from './routes/agent-public.js';
import { agentStreamsRoutes } from './routes/agent-streams.js';
import { internalAgentToolsRoutes } from './routes/internal-agent-tools.js';
import { notificationActionsRoutes } from './routes/notification-actions.js';
import { llmsTxtRoutes } from './routes/llms-txt.js';
import { authRoutes } from './routes/auth/index.js';
import { platformEventsPlugin } from './services/platform-events/index.js';
import { adminAuthRoutes } from './routes/admin-auth.js';
import { billingRoutes } from './routes/billing.js';
import { aiConfigRoutes } from './routes/ai-config.js';
import { peopleRoutes } from './routes/people.js';
import { peopleWebhookRoutes } from './routes/people-webhook.js';
import { aiVideoRoutes } from './routes/ai-videos.js';
import { startVideoSweeper } from './services/ai-router/video-sweeper.js';
import { startResponsesSweeper } from './services/ai-router/responses-sweeper.js';
import { startForkCountSweeper } from './services/fork-count-sweeper.js';
import { startCloneJobsPruner } from './services/clone-jobs-pruner.js';
import { startCloneJobsReaper } from './services/clone-jobs-reaper.js';
import { startCloneWebhookSweeper } from './services/clone-webhook-sweeper.js';
import { gatewayRoutes } from './routes/gateway.js';
import { aiMeetingsRoutes } from './routes/ai-meetings.js';
import { autoRefillRoutes } from './routes/auto-refill.js';
import dashboardProxyPlugin from './plugins/dashboard-proxy.js';
import subdomainPlugin from './plugins/subdomain.js';
import { subdomainApiRoutes } from './routes/subdomain-api.js';
import { suggestionsRoutes } from './routes/suggestions.js';
import { hackathonsMcpRoutes } from './routes/hackathons-mcp.js';
import { hackathonsAdminRoutes } from './routes/hackathons-admin.js';
import { hackathonsPublicRoutes, sseDispatcher } from './routes/hackathons-public.js';
import { adminRoutes } from './routes/admin.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { realtimePlugin } from './plugins/realtime.js';
import { realtimeRoutes } from './routes/realtime.js';
import { CognitoAuthProvider } from './services/cognito-auth-provider.js';
import { LocalAuthProvider } from './services/local-auth-provider.js';
import type { AuthProvider } from './services/auth-provider.js';
import { config, assertRegionConfig, assertInternalEmailSecret } from './config.js';
import { assertNeonProjectsConfig } from './services/neon-projects.js';
import { createAgentError } from './services/error-handler.js';
import { AppNotFoundError, AppAuthRequiredError, AppPausedError } from './services/app-resolver.js';
import { AuthorizationError, NotFoundError, ValidationError, ConflictError } from './services/api-errors.js';
import { startFlushWorker, reconcileUsage } from './services/usage-metering.js';
import { getRedisClient, shutdownRedis } from './services/redis.js';
import { enforceExpiredGracePeriods } from './services/billing-service.js';
import { autoRestoreSoftLockedUsers } from './services/billing-service.js';
import { startNeonTaskWorker } from './services/neon-task-worker.js';
import { startFailureNotifier } from './services/failure-notifier.js';
import { startDigestNotifier } from './services/digest-notifier.js';
import { startRagWorker } from './services/rag-worker.js';
import { startAnalyticsPullerCron } from './services/cf-analytics-puller.js';
import { startKvReconcileWorker } from './services/kv/reconcile-worker.js';
import { startKeysExpiryWorker } from './services/kv/keys-expiry-worker.js';
import { ragRoutes } from './routes/rag.js';
import { integrationRoutes } from './routes/integrations.js';
import { customDomainRoutes } from './routes/custom-domains.js';
import { partnerProxyRoutes } from './routes/partner-proxy.js';
import { partnerPoolsAdminRoutes } from './routes/partner-pools-admin.js';
import stateOutboxRoutes from './routes/admin/state-outbox.js';
import appIndexReaperRoutes from './routes/admin/app-index-reaper.js';
import internalLeaseRoutes from './routes/internal/lease.js';
import kvCredentialsRoutes from './routes/internal/kv-credentials.js';
import kvResolveJwtRoutes from './routes/internal/kv-resolve-jwt.js';
import visitBeaconRoutes from './routes/internal/visit-beacon.js';
import { internalEmailRoutes } from './routes/internal-email.js';
import kvQuotaPlugin from './plugins/kv-quota.js';
import kvAuditWriter from './plugins/kv-audit-writer.js';
import kvDataRoutes from './routes/v1/kv-data.js';
import kvExposeRoutes from './routes/v1/kv-expose.js';
import kvAdminRoutes from './routes/v1/kv-admin.js';
import kvAuditRecentRoutes from './routes/v1/kv-audit-recent.js';
import quotaStateRoutes from './routes/admin/quota-state.js';
import regionStateRoutes from './routes/admin/region-state.js';
import activeMigrationsRoutes from './routes/admin/active-migrations.js';
import kvAdminStatsRoutes from './routes/admin/kv-admin-stats.js';
import wapaMetricsRoutes from './routes/admin/wapa-metrics.js';
import adminActivityRoutes from './routes/admin/activity.js';
import moveAppRoutes from './routes/apps/move.js';
import reverseMoveRoutes from './routes/apps/reverse-move.js';
import sourceReplicaRoutes from './routes/apps/source-replicas.js';
import regionsRoutes from './routes/regions.js';
import { writeSubdomainMapping, writeDomainMapping } from './services/cloudflare-wfp.js';
import { updateOrgAppIndexRegion } from './services/org-app-index.js';
import { enqueueDeprovision } from './services/move-app/source-retention.js';
import { invalidateAppRegion, getRuntimeDbForApp } from './services/region-resolver.js';
import { resolveOrgFromApp } from './services/app-org-resolver.js';
import { resolveOrgFromApiKey } from './services/api-key-org-resolver.js';
import { runtimePoolFor, listRuntimeRegions } from './services/runtime-pool-registry.js';
import { redisFor } from './services/redis-registry.js';
import { auditRuntimeTablesForPool } from './services/move-app/runtime-table-audit.js';
import { waitForReplicationCaughtUp, promoteSourceToPrimary } from './services/move-app/neon-replication.js';

// Initialize Sentry
if (config.sentry.enabled) {
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    tracesSampleRate: 0.1,
    integrations: [
      Sentry.httpIntegration(),
    ],
  });
}

// Fail fast if region config is missing or malformed.
const regionConfig = assertRegionConfig();
console.log(`Starting in region ${regionConfig.instanceRegion} (allowed: ${regionConfig.regions.join(',')})`);

// Fail fast if any Neon data/runtime project IDs are missing for configured regions.
assertNeonProjectsConfig();

// Fail fast if INTERNAL_EMAIL_SECRET is still the dev default in staging/production.
assertInternalEmailSecret();


// Fail-closed: prevent startup with default secrets in production
if (process.env.NODE_ENV === 'production') {
  if (!process.env.AUTH_ENCRYPTION_KEY) {
    console.error('FATAL: AUTH_ENCRYPTION_KEY must be set in production. Exiting.');
    process.exit(1);
  }
  if (config.auth.enabled && !process.env.LOCAL_JWT_SECRET && !config.cognito.userPoolId) {
    console.error('FATAL: LOCAL_JWT_SECRET or COGNITO_USER_POOL_ID must be set when auth is enabled in production. Exiting.');
    process.exit(1);
  }
  if (!process.env.BUILD_RUNNER_SHARED_SECRET || process.env.BUILD_RUNNER_SHARED_SECRET === 'dev-shared-secret') {
    console.error('FATAL: BUILD_RUNNER_SHARED_SECRET must be set in production. Exiting.');
    process.exit(1);
  }
  if (!process.env.BUILD_RUNNER_URL || process.env.BUILD_RUNNER_URL.startsWith('http://localhost')) {
    console.error('FATAL: BUILD_RUNNER_URL must be set to a non-localhost URL in production. Exiting.');
    process.exit(1);
  }
}

function shouldLogRequest(url: string | undefined): boolean {
  if (!config.logging.requestLoggingEnabled) return false;
  if (!url) return true;
  const path = url.split('?')[0] ?? url;
  return !config.logging.ignoreRequestPaths.includes(path);
}

function getPathname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.split('?')[0] ?? url;
}

function assertE2EBypassesNotInProduction() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) return;
  if (process.env.BUTTERBASE_E2E === '1') {
    throw new Error(
      'BUTTERBASE_E2E=1 with NODE_ENV=production: refusing to start. ' +
      'This flag enables a test-only auth bypass (x-test-user-id header). ' +
      'Unset BUTTERBASE_E2E in your production environment.'
    );
  }
  if (process.env.KV_LOCAL_FILE) {
    throw new Error(
      'KV_LOCAL_FILE set with NODE_ENV=production: refusing to start. ' +
      'This flag short-circuits Cloudflare KV writes to a local file. ' +
      'Unset KV_LOCAL_FILE in your production environment.'
    );
  }
}

export async function buildApp() {
  assertE2EBypassesNotInProduction();

const app = Fastify({
  forceCloseConnections: 'idle',
  // We'll implement our own request logging to allow filtering noisy endpoints like `/mcp`.
  disableRequestLogging: true,
  logger: {
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url,
          headers: {
            host: request.headers.host,
            'user-agent': request.headers['user-agent'],
          },
          remoteAddress: request.ip,
        };
      },
    },
  },
});

// Decorate authProvider so admin routes (e.g. /admin/kv/cluster-health) that
// call requireAdmin() from lib/admin-guard can access the same provider as
// the main auth plugin and admin-auth.ts module-level instance.
app.decorate('authProvider', (config.cognito.userPoolId
  ? new CognitoAuthProvider(
      config.cognito.userPoolId,
      config.cognito.clientId,
      config.cognito.region,
    )
  : new LocalAuthProvider(config.auth.jwtSecret)) as AuthProvider);

// NOTE: application/x-www-form-urlencoded is parsed by the per-app OAuth
// route plugin (routes/auth/oauth.ts) via querystring.parse — that parser
// is registered globally on the Fastify instance, so /oauth/token also
// receives an object body. Do NOT add a second parser here; Fastify
// throws FST_ERR_CTP_ALREADY_PRESENT on duplicate registration.

// Capture all non-JSON, non-text request bodies as raw Buffers so function
// execution can forward them faithfully to the Deno runtime.
// Fastify's built-in application/json and text/plain parsers take precedence;
// this wildcard only fires for everything else (multipart, octet-stream, etc.).
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
  done(null, body);
});

app.addHook('onRequest', async (request) => {
  if (!shouldLogRequest(request.raw.url)) return;
  request.log.info({ req: request }, 'incoming request');
});

app.addHook('preHandler', async (request) => {
  if (!config.logging.mcpToolCallLoggingEnabled) return;
  if (request.method !== 'POST') return;
  if (getPathname(request.raw.url) !== '/mcp') return;

  const body = request.body as unknown as { method?: unknown; id?: unknown; params?: unknown } | undefined;
  if (!body || body.method !== 'tools/call') return;

  const params = body.params as { name?: unknown; arguments?: Record<string, unknown> } | undefined;
  const toolName = typeof params?.name === 'string' ? params.name : undefined;

  request.log.info(
    { mcp: { id: body.id, tool: toolName } },
    'mcp tool call'
  );

  if (toolName) {
    const args = (params?.arguments as Record<string, unknown>) ?? {};
    const appId = typeof args.app_id === 'string' ? args.app_id : null;
    const apiKeyId = request.auth?.keyId ?? null;
    const userId = request.auth?.userId ?? null;

    const region = assertRegionConfig().instanceRegion;
    // Attribute every MCP tool call. If app_id is present, use apps.organization_id.
    // Otherwise fall back to the api key's organization_id — both are NOT NULL post
    // Plan 07 (api_keys) / Plan 11.5 (apps), so we always land a row.
    (async () => {
      try {
        let organizationId: string;
        if (appId) {
          organizationId = await resolveOrgFromApp(app.runtimeDb(region), appId);
        } else if (apiKeyId) {
          organizationId = await resolveOrgFromApiKey(app.controlDb, apiKeyId);
        } else {
          // No api key and no app_id: this is a session-authenticated path that
          // shouldn't reach the public /mcp endpoint. Log and skip.
          request.log.warn({ toolName }, 'mcp tool call with no apiKeyId and no app_id — skipped');
          return;
        }
        await app.runtimeDb(region).query(
          `INSERT INTO mcp_tool_call_log (api_key_id, user_id, tool_name, parameters, app_id, organization_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [apiKeyId, userId, toolName, JSON.stringify(args), appId, organizationId]
        );
      } catch (err) {
        request.log.warn({ err }, 'failed to log mcp tool call');
      }
    })();
  }
});

// Provisioning guard: reject data-plane requests to unprovisioned apps
app.addHook('preHandler', async (request, reply) => {
  const url = getPathname(request.raw.url) ?? '';
  const match = url.match(/^\/v1\/(app_[a-z0-9]+)\//);
  if (!match) return;

  const appId = match[1];

  // Skip routes that only use the control DB
  if (url.includes('/fn/') || url.includes('/billing/')) return;

  let runtimeDb;
  try {
    runtimeDb = await getRuntimeDbForApp(app.controlDb, appId);
  } catch (err) {
    // Unknown app — let the route handler return a 404 instead of a 409.
    if (err instanceof AppNotFoundError) return;
    throw err;
  }
  const result = await runtimeDb.query(
    'SELECT db_provisioned, provisioning_status FROM apps WHERE id = $1',
    [appId]
  );

  if (result.rows.length === 0) return; // Let route handler deal with 404

  if (!result.rows[0].db_provisioned) {
    const status = result.rows[0].provisioning_status;
    return reply.code(409).send(createAgentError({
      code: 'APP_PROVISIONING',
      message: status === 'failed'
        ? 'App database provisioning failed. Delete and recreate the app.'
        : 'App database is still being provisioned. Poll GET /apps/:app_id/status and retry when ready.',
      remediation: 'Wait for provisioning to complete, then retry.',
    }));
  }

  if (result.rows[0].provisioning_status === 'deleting') {
    return reply.code(410).send(createAgentError({
      code: 'APP_DELETING',
      message: 'This app is being deleted and cannot accept requests.',
      remediation: 'The app is being permanently removed. Poll GET /apps/:app_id/status — a 404 response confirms deletion is complete.',
    }));
  }
});

app.addHook('onResponse', async (request, reply) => {
  if (!shouldLogRequest(request.raw.url)) return;
  request.log.info(
    {
      res: { statusCode: reply.statusCode },
      responseTime: reply.elapsedTime,
    },
    'request completed'
  );
});

// Sentry error handler
app.setErrorHandler((error: any, request, reply) => {
  if (reply.sent) return;

  // Typed app-resolver errors → agent-friendly 404/401/503 instead of opaque 500.
  // These are thrown by AppResolver / resolveAppHomeRegion / getRuntimeDbForApp
  // when an app id is unknown, requires auth, or has been paused. Routes that
  // call those helpers don't all wrap them in try/catch, so centralize here.
  if (error instanceof AppNotFoundError) {
    return reply.status(404).send(createAgentError({
      code: 'RESOURCE_NOT_FOUND',
      message: error.message,
      remediation: 'Verify the app id with `butterbase apps list` (or list_apps via MCP). Ensure the caller owns the app.',
    }));
  }
  if (error instanceof AppAuthRequiredError) {
    return reply.status(401).send(createAgentError({
      code: 'AUTH_INVALID_TOKEN',
      message: error.message,
      remediation: 'Authenticate first: `butterbase login` or attach a user JWT.',
    }));
  }
  if (error instanceof AppPausedError) {
    return reply.status(503).send(createAgentError({
      code: 'APP_PAUSED',
      message: error.message,
      remediation: 'Resume the app with `butterbase apps resume <app-id>` (or manage_app action="resume" via MCP).',
      details: { reason: error.reason },
    }));
  }

  if (error instanceof AuthorizationError) {
    return reply.status(403).send(createAgentError({
      code: error.code,
      message: error.message,
      remediation: 'You do not have permission to perform this action. Check your role/membership or use a different key.',
    }));
  }
  if (error instanceof NotFoundError) {
    return reply.status(404).send(createAgentError({
      code: 'RESOURCE_NOT_FOUND',
      message: error.message,
      remediation: `Verify the ${error.resourceType} id and that it exists.`,
    }));
  }
  if (error instanceof ValidationError) {
    return reply.status(400).send(createAgentError({
      code: error.code,
      message: error.message,
      remediation: 'Check the input shape and required fields.',
    }));
  }
  if (error instanceof ConflictError) {
    return reply.status(409).send(createAgentError({
      code: error.code,
      message: error.message,
      remediation: 'The requested operation conflicts with the current resource state.',
    }));
  }

  // Trust the original statusCode when the throwing site set one (typed errors
  // like RouterError → 502, AdapterError → upstream status, etc). Only fall
  // back to 500 for truly unclassified errors. Previously we clamped anything
  // ≥500 down to a generic 500 INTERNAL_ERROR, which masked legitimate 502/503
  // responses from upstream routers and left callers without a real reason.
  const hasTypedStatus = typeof error.statusCode === 'number' && error.statusCode >= 400;
  const statusCode = hasTypedStatus ? error.statusCode : 500;

  if (statusCode >= 500 && config.sentry.enabled) {
    Sentry.captureException(error, {
      contexts: {
        fastify: {
          method: request.method,
          url: request.url,
          params: request.params,
          query: request.query,
        },
      },
    });
  }

  if (statusCode >= 500) {
    app.log.error(error);
    // If the error carries its own typed code/message, surface a sanitized
    // version so the client gets a useful payload instead of an opaque
    // INTERNAL_ERROR. Internal-only fields (router names, fallback chains,
    // upstream codes that name a provider) are intentionally NOT echoed —
    // those live in logs/Sentry only.
    if (hasTypedStatus && typeof error.code === 'string') {
      const INTERNAL_CODES = new Set([
        'ROUTER_FALLBACK_EXHAUSTED',
        'NO_ROUTERS_AVAILABLE',
      ]);
      const publicCode = INTERNAL_CODES.has(error.code) ? 'MODEL_UNAVAILABLE' : error.code;
      const body: Record<string, unknown> = {
        code: publicCode,
        message: typeof error.message === 'string' ? error.message : 'Service temporarily unavailable',
        remediation: 'The model is temporarily unavailable. Retry the request, or try a different model.',
      };
      return reply.status(statusCode).send({ error: body });
    }
    const details = config.nodeEnv !== 'production'
      ? { error_class: error.constructor?.name, error_message: error.message }
      : undefined;
    return reply.status(500).send(createAgentError({
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred while processing your request',
      remediation: 'This is an unexpected error. Please retry the request. If the problem persists, check your inputs and consult the documentation.',
      details,
    }));
  }

  // Wrap 4xx errors in agent-friendly format
  if (error.validation) {
    return reply.status(statusCode).send(createAgentError({
      code: 'VALIDATION_INVALID_SCHEMA',
      message: error.message,
      remediation: 'Review the validation errors and correct your request.',
      details: error.validation,
    }));
  }

  return reply.status(statusCode).send(createAgentError({
    code: 'REQUEST_ERROR',
    message: error.message,
    remediation: 'Check your request parameters and retry.',
  }));
});

app.register(cookie, { secret: process.env.COOKIE_SECRET ?? 'dev-cookie-secret-change-in-production' });
app.register(databasePlugin);
app.register(runtimeDatabasePlugin);
app.register(dataPlanePlugin);
app.register(realtimePlugin);
app.register(corsPlugin);
app.register(internalAuthPlugin);

// Cloud overlays bootstrap — registers StripeBillingProvider + LeaseQuotaEnforcer
// when the overlay is present. In OSS mode (overlay absent) the dynamic import
// fails, registries fall back to Noop/Unlimited defaults, and Stripe-backed
// routes are simply not registered.
try {
  // @ts-expect-error — path resolved at runtime against the compiled overlay
  const overlay = await import('../../../cloud-overlays/dist/cloud-overlays/bootstrap.js');
  await overlay.bootstrapCloudOverlays();
  if (config.meetings?.apiKey) {
    overlay.bootstrapMeetings({
      apiKey: config.meetings.apiKey,
      baseUrl: config.meetings.baseUrl,
    });
    app.log.info('ai-meetings provider registered');
  }
  app.log.info('Cloud overlays loaded');
} catch (err) {
  app.log.info(
    { err: (err as Error)?.message },
    'No cloud overlays found, running in OSS mode (Noop billing, Unlimited quotas)',
  );
}

app.register(internalLeaseRoutes);
app.register(kvCredentialsRoutes);
app.register(kvResolveJwtRoutes);
app.register(visitBeaconRoutes);
app.register(internalEmailRoutes);
// kv-quota MUST be registered before kv-data/expose/admin routes so the
// preHandler hook and kvAccount decoration are available when those routes mount.
app.register(kvQuotaPlugin);
app.register(kvAuditWriter);
app.register(kvDataRoutes);
app.register(kvExposeRoutes);
app.register(kvAdminRoutes);
app.register(kvAuditRecentRoutes);
app.register(stateOutboxRoutes);
app.register(appIndexReaperRoutes);
app.register(quotaStateRoutes);
app.register(regionStateRoutes);
app.register(activeMigrationsRoutes);
app.register(kvAdminStatsRoutes);
app.register(wapaMetricsRoutes);
app.register(adminActivityRoutes);
app.register(subdomainPlugin);
app.register(authPlugin);
app.register(quotaEnforcementPlugin);
app.register(flyReplayPlugin);
app.register(migrationGuardPlugin);
app.register(rateLimitPlugin);
app.register(healthRoutes);
app.register(llmsTxtRoutes);
await app.register(platformEventsPlugin);
app.register(authRoutes);
app.register(adminAuthRoutes);
app.register(billingRoutes);
app.register(dashboardProxyPlugin);
try {
  // @ts-expect-error — overlay path resolved at runtime
  const overlay = await import('../../../cloud-overlays/dist/cloud-overlays/billing/routes/app-billing.js');
  await app.register(overlay.appBillingRoutes);
} catch { /* OSS mode: no Stripe app billing */ }
if (config.meetings?.webhookSecret) {
  try {
    // @ts-expect-error — overlay path resolved at runtime
    const overlay = await import('../../../cloud-overlays/dist/cloud-overlays/bootstrap.js');
    const { getActorProvider } = await import('./services/actor-providers/registry.js');
    await app.register(overlay.recallWebhookRoute, {
      secret: config.meetings.webhookSecret,
      getProvider: () => getActorProvider('meetings'),
    });
    app.log.info('ai-meetings webhook route registered');
  } catch (err) {
    app.log.info(
      { err: err instanceof Error ? err.message : err },
      'ai-meetings webhook overlay not present, skipping',
    );
  }
}
try {
  // @ts-expect-error — overlay path resolved at runtime
  const overlay = await import('../../../cloud-overlays/dist/cloud-overlays/substrate/index.js');
  await app.register(overlay.substrateRoutes);
  app.log.info('substrate overlay routes registered');
  await app.register(overlay.substrateInternalBridge);
  app.log.info('substrate internal bridge registered');
  // @ts-expect-error — overlay path resolved at runtime
  const appSubstrate = await import('../../../cloud-overlays/dist/cloud-overlays/control-api-app-substrate.js');
  await app.register(appSubstrate.appSubstrateRoutes);
  app.log.info('app-substrate link routes registered');
} catch (err) {
  app.log.info({ err: err instanceof Error ? err.message : err }, 'substrate overlay not present, skipping');
}
try {
  // @ts-expect-error — overlay path resolved at runtime
  const orgs = await import('../../../cloud-overlays/dist/cloud-overlays/organizations/routes.js');
  await app.register(orgs.organizationsRoutes);
  app.log.info('organizations overlay routes registered');
} catch (err) {
  app.log.info({ err: err instanceof Error ? err.message : err }, 'organizations overlay not present, skipping');
}
app.register(aiConfigRoutes);
app.register(peopleRoutes);
app.register(peopleWebhookRoutes);
app.register(aiVideoRoutes);
app.register(gatewayRoutes);
app.register(aiMeetingsRoutes);
app.register(autoRefillRoutes);
app.register(initRoutes);
app.register(schemaRoutes);
app.register(autoApiRoutes);
app.register(rlsRoutes);
app.register(oauthConfigRoutes);
app.register(auditLogRoutes);
app.register(wellKnownRoutes);
app.register(oauthRoutes);
app.register(mcpRoutes);
app.register(storageRoutes);
app.register(appConfigRoutes);
app.register(cloneWebhookConfigRoutes);
app.register(repoRoutes);
app.register(cloneRoutes);
app.register(cloneRoutesPreflight);
app.register(templatesDiscoveryRoutes);
app.register(registerFunctionRoutes);
app.register(registerAppEnvRoutes);
app.register(registerFrontendRoutes);
app.register(registerEdgeSsrRoutes);
app.register(registerEdgeSsrFromSourceRoutes);
app.register(registerFrontendFromSourceRoutes);
app.register(registerDurableObjectRoutes);
app.register(registerWebhookRoutes);
app.register(agentsRoutes);
app.register(agentPublicRoutes);
app.register(agentStreamsRoutes);
app.register(internalAgentToolsRoutes);
app.register(notificationActionsRoutes);
app.register(subdomainApiRoutes);
app.register(suggestionsRoutes);
app.register(hackathonsMcpRoutes);
app.register(hackathonsAdminRoutes);
app.register(hackathonsPublicRoutes);
app.register(adminRoutes);
try {
  // @ts-expect-error — overlay path resolved at runtime
  const overlay = await import('../../../cloud-overlays/dist/cloud-overlays/billing/routes/admin-enterprise-billing.js');
  await app.register(overlay.default ?? overlay.adminEnterpriseBillingRoutes);
} catch { /* OSS mode: no enterprise billing */ }
app.register(apiKeyRoutes);
app.register(realtimeRoutes);
app.register(ragRoutes);
app.register(integrationRoutes);
app.register(customDomainRoutes);
if (config.partnerProxy.enabled) {
  app.register(partnerProxyRoutes);
}
app.register(partnerPoolsAdminRoutes);
app.register(regionsRoutes);
app.register(moveAppRoutes);

// Wire reverse-move ctx (mirrors cron-scheduler sagaCtx for the forward path).
// waitForReplicationCaughtUp/promoteSourceToPrimary are TODO stubs (Neon API);
// the route catches and returns 409 for v1.
app.decorate('moveAppCtx', {
  get controlPool() { return app.controlDb; },
  runtimePoolFor,
  writeSubdomainMapping,
  writeDomainMapping,
  listCustomDomains: async (region: string, appId: string) => {
    const { rows } = await runtimePoolFor(region).query<{ hostname: string }>(
      `SELECT hostname FROM app_custom_domains WHERE app_id = $1 AND archived_after_move IS NULL`,
      [appId],
    );
    return rows;
  },
  invalidateCacheAllRegions: async (appId: string) => {
    for (const region of listRuntimeRegions()) {
      try { await invalidateAppRegion(redisFor(region), appId); } catch {}
    }
  },
  updateOrgAppIndexRegion,
  ...(process.env.MOVE_APP_REPLICATION_ENABLED === 'true'
    ? {
        waitForReplicationCaughtUp: (region: string, appId: string, migrationId: string) =>
          waitForReplicationCaughtUp({ sourceRegion: region, appId, migrationId }),
        promoteSourceToPrimary: (region: string, appId: string, migrationId: string) =>
          promoteSourceToPrimary({ sourceRegion: region, appId, migrationId }),
      }
    : {
        // Local-only no-ops preserved if flag is off (e.g. unit tests)
        waitForReplicationCaughtUp: async (region: string, appId: string) => {
          app.log.info({ region, appId }, 'waitForReplicationCaughtUp: local no-op (replication disabled)');
        },
        promoteSourceToPrimary: async (region: string, appId: string) => {
          app.log.info({ region, appId }, 'promoteSourceToPrimary: local no-op (replication disabled)');
        },
      }),
  enqueueDeprovision: (region: string, appId: string, neonDbName: string) => enqueueDeprovision(app.controlDb, region, appId, neonDbName),
});
app.register(reverseMoveRoutes);
app.register(sourceReplicaRoutes);

// Register KV keys-expiry onClose hook NOW (before app.ready() is called), so
// addHook does not throw FST_ERR_INSTANCE_ALREADY_LISTENING.  avvio fires the
// 'start' event — and sets fastify.started = true — when ready() resolves, so
// any addHook called after that point will throw. We start the subscriber here
// and register the cleanup hook; the subscriber begins connecting immediately.
if (process.env.NODE_ENV !== 'test') {
  const regionsRaw = process.env.BUTTERBASE_REGIONS ?? '';
  const kvRegions = regionsRaw.split(',').map((r) => r.trim()).filter(Boolean);
  if (kvRegions.length > 0) {
    const keysExpiry = startKeysExpiryWorker({
      regions: kvRegions,
      urlForRegion: (region) => {
        const envKey = `KV_REDIS_URL_${region.toUpperCase().replace(/-/g, '_')}`;
        const url = process.env[envKey];
        if (!url) throw new Error(`Missing ${envKey}`);
        return url;
      },
      log: app.log,
    });
    app.log.info({ regions: kvRegions }, 'KV expiry-subscriber started');
    app.addHook('onClose', async () => { await keysExpiry.stop(); });
    app.addHook('onClose', async () => {
      if ((app as any).cloneJobsPrunerHandle) {
        await (app as any).cloneJobsPrunerHandle.stop();
      }
      if ((app as any).cloneJobsReaperHandle) {
        await (app as any).cloneJobsReaperHandle.stop();
      }
      if ((app as any).cloneWebhookSweeperHandle) {
        await (app as any).cloneWebhookSweeperHandle.stop();
      }
    });
  } else {
    app.log.warn('BUTTERBASE_REGIONS empty — KV expiry-subscriber not started');
  }
}

// Start background workers after server is ready
Promise.resolve(app.ready())
  .then(() => {
    // Start usage metering flush worker (every 60 seconds)
    const flushInterval = startFlushWorker(app.controlDb, 60000);
    app.log.info('Usage metering flush worker started');

    // Start hackathon submissions SSE dispatcher (process-level LISTEN)
    sseDispatcher.start(app.controlDb).catch((err) => {
      app.log.error({ err }, 'Failed to start hackathon SSE dispatcher');
    });

    // Start failure-notifier scanner (every 5 minutes)
    const failureNotifierInterval = startFailureNotifier(app.controlDb, app.log);
    (app as any).failureNotifierInterval = failureNotifierInterval;

    // Start weekly-digest scanner (hourly tick; sends Sunday 18:00 UTC)
    const digestNotifierInterval = startDigestNotifier(app.controlDb, app.log);
    (app as any).digestNotifierInterval = digestNotifierInterval;

    // Start neon_tasks queue worker (polls every 2 seconds).
    // Always start: executeProvision has a local-Postgres branch when
    // config.neon.enabled is false, and clone tasks must be processed
    // regardless of provisioning backend.
    const neonWorkerInterval = startNeonTaskWorker(app.controlDb, app.dataPlaneDb, app.log);
    (app as any).neonWorkerInterval = neonWorkerInterval;
    app.log.info('neon_tasks queue worker started');

    // Start RAG ingestion worker (polls every 5 seconds)
    const ragWorkerInterval = startRagWorker(app.controlDb, app.log);
    (app as any).ragWorkerInterval = ragWorkerInterval;
    app.log.info('RAG ingestion worker started');

    // Start Cloudflare analytics puller (fires once at startup, then every 15 min)
    const analyticsPullerInterval = startAnalyticsPullerCron(app.controlDb);
    (app as any).analyticsPullerInterval = analyticsPullerInterval;

    // Start KV storage-counter reconcile worker (every 24 hours)
    const kvReconcileInterval = startKvReconcileWorker(app.controlDb);
    (app as any).kvReconcileInterval = kvReconcileInterval;
    app.log.info('KV reconcile worker started (24h interval)');

    // Schedule nightly soft-lock auto-restore check (runs at 2 AM)
    const scheduleNightlyRestore = () => {
      const now = new Date();
      const next2AM = new Date(now);
      next2AM.setHours(2, 0, 0, 0);

      // If it's already past 2 AM today, schedule for tomorrow
      if (now.getHours() >= 2) {
        next2AM.setDate(next2AM.getDate() + 1);
      }

      const msUntil2AM = next2AM.getTime() - now.getTime();

      const nightlyTimeout = setTimeout(() => {
        // Run nightly billing tasks
        const runNightlyBillingTasks = async () => {
          const redis = getRedisClient();
          const acquired = await redis.set('lock:nightly-billing', '1', 'EX', 3600, 'NX');
          if (acquired !== 'OK') {
            app.log.info('Nightly billing tasks skipped (another instance holds the lock)');
            return;
          }

          try {
            await autoRestoreSoftLockedUsers(app.controlDb).catch((err) => {
              app.log.error({ err }, 'Failed to run nightly soft-lock restore');
            });
            await enforceExpiredGracePeriods(app.controlDb).catch((err) => {
              app.log.error({ err }, 'Failed to enforce expired grace periods');
            });

            // Reconcile usage for paying users
            try {
              const now = new Date();
              const periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
              const usersResult = await app.controlDb.query(
                `SELECT id FROM platform_users`
              );
              for (const row of usersResult.rows) {
                await reconcileUsage(app.controlDb, row.id, periodStart).catch((err) => {
                  app.log.error({ err, userId: row.id }, 'Failed to reconcile usage');
                });
              }
              app.log.info(`Reconciled usage for ${usersResult.rows.length} users`);
            } catch (err) {
              app.log.error({ err }, 'Failed to run nightly usage reconciliation');
            }

            // Clean up old processed webhook events (older than 30 days)
            await app.controlDb.query(
              `DELETE FROM processed_webhook_events WHERE processed_at < now() - interval '30 days'`
            ).catch((err) => {
              app.log.error({ err }, 'Failed to clean up old webhook events');
            });

            // Retention pruning. Tables live in control-plane (legacy/admin writes)
            // and per-region runtime DBs (auth + per-app writes), so prune both.
            const retentionDeletes: Array<{ sql: string; label: string }> = [
              { sql: `DELETE FROM function_invocations WHERE started_at < now() - interval '7 days'`, label: 'function_invocations' },
              { sql: `DELETE FROM audit_events WHERE created_at < now() - interval '180 days'`, label: 'audit_events' },
            ];
            for (const { sql, label } of retentionDeletes) {
              await app.controlDb.query(sql).catch((err) => {
                app.log.error({ err, table: label, scope: 'control-plane' }, 'Retention prune failed');
              });
            }

            const runtimeDeletes: Array<{ sql: string; label: string }> = [
              ...retentionDeletes,
              { sql: `DELETE FROM agent_run_events WHERE created_at < now() - interval '30 days'`, label: 'agent_run_events' },
              { sql: `DELETE FROM agent_tool_audits WHERE created_at < now() - interval '30 days'`, label: 'agent_tool_audits' },
            ];
            for (const region of listRuntimeRegions()) {
              const pool = (() => {
                try { return runtimePoolFor(region); }
                catch (err) {
                  app.log.error({ err, region }, 'Retention prune: missing runtime pool for region');
                  return null;
                }
              })();
              if (!pool) continue;
              for (const { sql, label } of runtimeDeletes) {
                await pool.query(sql).catch((err) => {
                  app.log.error({ err, table: label, region, scope: 'runtime-plane' }, 'Retention prune failed');
                });
              }
            }
          } finally {
            await redis.del('lock:nightly-billing').catch(() => {});
          }
        };

        runNightlyBillingTasks();

        // Schedule next run (24 hours later)
        const nightlyInterval = setInterval(() => {
          runNightlyBillingTasks();
        }, 24 * 60 * 60 * 1000);
        (app as any).nightlyInterval = nightlyInterval;
      }, msUntil2AM);
      (app as any).nightlyTimeout = nightlyTimeout;

      app.log.info(`Nightly soft-lock restore scheduled for ${next2AM.toISOString()}`);
    };

    scheduleNightlyRestore();

    // Store interval for cleanup
    (app as any).flushInterval = flushInterval;

    // Video sweeper: server-driven settle for jobs whose customers never poll
    // back after the upstream completes. Per-region Redis lock prevents
    // duplicate work across machines. Skip in tests (no runtime DBs).
    if (process.env.SKIP_VIDEO_SWEEPER !== '1') {
      startVideoSweeper(app, 30_000)
        .then((stop) => { (app as any).videoSweeperStop = stop; })
        .catch((err: unknown) => {
          app.log.error({ err }, 'video-sweeper: failed to start');
        });
    }

    // Fork-count sweeper: processes cross-region fork_count_decrements outbox
    // rows that the runtime DELETE trigger cannot handle (different-region source).
    // Skip in tests (SKIP_FORK_SWEEPER=1) or when no runtime DBs are configured.
    if (process.env.SKIP_FORK_SWEEPER !== '1') {
      const forkSweeperHandle = startForkCountSweeper(app.controlDb, config.runtimeDb, app.log);
      (app as any).forkSweeperHandle = forkSweeperHandle;
    }

    // Responses sweeper: deletes expired ai_responses rows (expires_at < now)
    // across all runtime regions. Runs hourly; gracefully skips regions whose
    // DBs have not yet run migration 029.
    if (process.env.SKIP_RESPONSES_SWEEPER !== '1') {
      const responsesSweeperHandle = startResponsesSweeper(config.runtimeDb, app.log);
      (app as any).responsesSweeperHandle = responsesSweeperHandle;
    }

    // Clone-jobs pruner: deletes template_clone_jobs rows in status
    // 'completed' or 'failed' older than 30 days (runs every 24 h).
    if (process.env.SKIP_CLONE_JOBS_PRUNER !== '1') {
      const cloneJobsPrunerHandle = startCloneJobsPruner(app.controlDb, app.log);
      (app as any).cloneJobsPrunerHandle = cloneJobsPrunerHandle;
      app.log.info('Clone-jobs pruner started (24h interval)');
    }

    // Clone-jobs reaper: flips template_clone_jobs stuck in a mid-stage
    // status (>15 min, no live neon_task) to 'failed' and notifies the
    // owner + ops. Backstops the neon_tasks retry logic for scenarios
    // where a control-api instance died mid-pipeline (runs every 5 min).
    if (process.env.SKIP_CLONE_JOBS_REAPER !== '1') {
      const cloneJobsReaperHandle = startCloneJobsReaper(app.controlDb, app.log);
      (app as any).cloneJobsReaperHandle = cloneJobsReaperHandle;
      app.log.info('Clone-jobs reaper started (5m interval)');
    }

    // Clone-webhook sweeper: delivers clone_webhook_outbox rows with HMAC-SHA256
    // signing and 3-attempt exponential-backoff retry (runs every 30 s).
    if (process.env.SKIP_CLONE_WEBHOOK_SWEEPER !== '1') {
      const cloneWebhookSweeperHandle = startCloneWebhookSweeper(app.controlDb, app.log);
      (app as any).cloneWebhookSweeperHandle = cloneWebhookSweeperHandle;
      app.log.info('Clone-webhook sweeper started (30s interval)');
    }
  })
  .catch((err: unknown) => {
    app.log.error({ err }, 'Failed to start background workers');
  });

  // Boot-time audit: ensure every per-app runtime table is classified.
  // Skip if SKIP_RUNTIME_AUDIT=1 (used by unit tests without real DBs).
  // Each region is wrapped in a 15s timeout so a slow/unreachable region does
  // NOT block startup — `app.listen()` must run for the proxy to route traffic.
  if (process.env.SKIP_RUNTIME_AUDIT !== '1') {
    const regions = listRuntimeRegions();
    app.log.info({ regions }, 'runtime-table-audit: starting');
    for (const region of regions) {
      const started = Date.now();
      app.log.info({ region }, 'runtime-table-audit: region begin');
      try {
        await Promise.race([
          auditRuntimeTablesForPool(runtimePoolFor(region), region),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('audit timeout 15s')), 15000),
          ),
        ]);
        app.log.info({ region, ms: Date.now() - started }, 'runtime-table-audit passed');
      } catch (e: any) {
        if (e.message?.includes('unclassified')) throw e;
        app.log.warn({ region, err: e.message, ms: Date.now() - started }, 'runtime-table-audit skipped (region unreachable or slow)');
      }
    }
    app.log.info('runtime-table-audit: complete');
  }

  return app;
}

// Entry-point gate: only listen + install signal handlers when this file is
// being run as the server (not when imported by e2e tests). Keyed off
// NODE_ENV — PM2 ecosystem sets 'production'; vitest sets 'test'. Comparing
// import.meta.url to argv[1] is unreliable under PM2's ESM forker (argv[1]
// is PM2's ProcessContainerFork.js, not our module).
if (process.env.NODE_ENV !== 'test') {
  const app = await buildApp();

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down`);

      // Stop background workers (prevent new work from starting)
      if ((app as any).flushInterval) clearInterval((app as any).flushInterval);
      if ((app as any).nightlyTimeout) clearTimeout((app as any).nightlyTimeout);
      if ((app as any).nightlyInterval) clearInterval((app as any).nightlyInterval);
      if ((app as any).neonWorkerInterval) clearInterval((app as any).neonWorkerInterval);
      if ((app as any).failureNotifierInterval) clearInterval((app as any).failureNotifierInterval);
      if ((app as any).analyticsPullerInterval) clearInterval((app as any).analyticsPullerInterval);
      if ((app as any).kvReconcileInterval) clearInterval((app as any).kvReconcileInterval);
      if ((app as any).videoSweeperStop) (app as any).videoSweeperStop();
      if ((app as any).forkSweeperHandle) await (app as any).forkSweeperHandle.stop().catch(() => {});
      if ((app as any).responsesSweeperHandle) await (app as any).responsesSweeperHandle.stop().catch(() => {});
      if ((app as any).cloneJobsPrunerHandle) await (app as any).cloneJobsPrunerHandle.stop().catch(() => {});
      if ((app as any).cloneJobsReaperHandle) await (app as any).cloneJobsReaperHandle.stop().catch(() => {});
      if ((app as any).cloneWebhookSweeperHandle) await (app as any).cloneWebhookSweeperHandle.stop().catch(() => {});

      // Timeout: force exit if shutdown hangs
      const shutdownTimeout = setTimeout(() => {
        app.log.error('Shutdown timed out after 15s, forcing exit');
        process.exit(1);
      }, 15_000);

      try {
        // app.close() drains in-flight requests and fires onClose hooks
        // (database pools, realtime manager, data-plane pools are all cleaned up via hooks)
        await app.close();
        await shutdownRedis();
      } catch (err) {
        app.log.error({ err }, 'Error during shutdown');
      } finally {
        clearTimeout(shutdownTimeout);
        process.exit(0);
      }
    });
  }

  app.listen({ port: config.port, host: '0.0.0.0' }, (err) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
  });
}
