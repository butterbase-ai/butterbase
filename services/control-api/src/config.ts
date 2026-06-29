import { loadRegionConfig, type RegionConfig, regionToEnvSuffix } from '@butterbase/shared';

let cachedRegionConfig: RegionConfig | null = null;

/**
 * Validate and return the region configuration. Throws RegionConfigError if env vars are missing
 * or invalid. Call this from each service's startup path before binding any port.
 */
export function assertRegionConfig(): RegionConfig {
  if (cachedRegionConfig) return cachedRegionConfig;
  cachedRegionConfig = loadRegionConfig(process.env);
  return cachedRegionConfig;
}

/** SES requires a real AWS region; R2/S3 often use AWS_REGION=auto, which breaks the SES endpoint. */
function resolveSesRegion(): string {
  const explicit = process.env.SES_REGION?.trim();
  if (explicit) return explicit;
  const aws = process.env.AWS_REGION?.trim();
  if (aws && aws.toLowerCase() !== 'auto') return aws;
  return 'us-east-1';
}

export const config = {
  port: parseInt(process.env.CONTROL_API_PORT ?? '4000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  publicUrl: process.env.PUBLIC_URL,

  logging: {
    requestLoggingEnabled: process.env.CONTROL_API_REQUEST_LOGGING !== 'false',
    mcpToolCallLoggingEnabled: process.env.CONTROL_API_MCP_TOOL_CALL_LOGGING !== 'false',
    ignoreRequestPaths: (process.env.CONTROL_API_LOG_IGNORE_PATHS ?? '/mcp,/health,/health/ready,/v1/public/hackathons/active,/v1/internal/state-outbox/drain,/v1/internal/lease/reclaim')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  auth: {
    enabled: process.env.AUTH_ENABLED !== 'false',
    jwtSecret: process.env.LOCAL_JWT_SECRET ?? (process.env.NODE_ENV === 'production' ? '' : 'dev-secret'),
    encryptionKey: process.env.AUTH_ENCRYPTION_KEY ?? (process.env.NODE_ENV === 'production' ? '' : '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  },

  cognito: {
    // Defaults match docker-compose / dashboard when dashboard-api/.env is absent
    userPoolId: process.env.COGNITO_USER_POOL_ID ?? '',
    clientId: process.env.COGNITO_CLIENT_ID ?? '',
    region: process.env.COGNITO_REGION ?? '',
  },

  devOwnerId: process.env.DEV_OWNER_ID ?? '00000000-0000-0000-0000-000000000001',

  controlDb: {
    url: process.env.CONTROL_DB_URL ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control',
  },

  aiRouter: (() => {
    const rawMarkup = parseFloat(process.env.AI_MARKUP_PERCENT ?? '');
    const markupPct = Math.max(0, Math.min(200, Number.isFinite(rawMarkup) ? rawMarkup : 0));
    return {
      enabled: process.env.AI_ROUTER_V2_ENABLED === 'true',
      presenceModeEnabled: process.env.AI_ROUTER_PRESENCE_MODE === 'true',
      v2EndpointsEnabled: process.env.AI_GATEWAY_V2_ENDPOINTS_ENABLED === 'true',
      defaultRegion: process.env.AI_ROUTER_DEFAULT_REGION ?? 'us-east-1',
      markupPct,
      platformDefaultModel: process.env.PLATFORM_DEFAULT_MODEL ?? 'anthropic/claude-3-5-sonnet',
      openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
      providerPrimaryApiKey: process.env.AI_PROVIDER_PRIMARY_API_KEY ?? '',
      providerPrimaryBaseUrl: process.env.AI_PROVIDER_PRIMARY_BASE_URL || undefined,
      providerSecondaryApiKey: process.env.AI_PROVIDER_SECONDARY_API_KEY ?? '',
      providerSecondaryBaseUrl: process.env.AI_PROVIDER_SECONDARY_BASE_URL || undefined,
      providerSecondaryCatalogUrl: process.env.AI_PROVIDER_SECONDARY_CATALOG_URL || undefined,
      providerTertiaryApiKey: process.env.AI_PROVIDER_TERTIARY_API_KEY ?? '',
      providerTertiaryBaseUrl: process.env.AI_PROVIDER_TERTIARY_BASE_URL || undefined,
      catalogRefreshLockTtlSec: parseInt(process.env.AI_CATALOG_LOCK_TTL_SEC ?? '600', 10),
    } as const;
  })(),

  meetings: {
    apiKey: process.env.MEETINGS_API_KEY ?? '',
    baseUrl: process.env.MEETINGS_BASE_URL ?? 'https://us-east-1.recall.ai',
    webhookSecret: process.env.MEETINGS_WEBHOOK_SECRET ?? '',
    // The outbound webhook forwarder signs with each app's per-app secret
    // (stored AES-256-GCM-encrypted under AUTH_ENCRYPTION_KEY in
    // app_meetings_webhooks.forward_secret_encrypted), so no service-wide
    // signing key is required.
  },

  enrichlayer: {
    apiKey: process.env.ENRICHLAYER_API_KEY ?? '',
    baseUrl: process.env.ENRICHLAYER_BASE_URL ?? 'https://enrichlayer.com/api/v2',
    fallbackCreditsPerAction: parseInt(process.env.ENRICHLAYER_FALLBACK_CREDITS_PER_ACTION ?? '3', 10),
    minBalanceUsd: parseFloat(process.env.ENRICHLAYER_MIN_BALANCE_USD ?? '0.05'),
    emailLookupCredits: parseInt(process.env.ENRICHLAYER_EMAIL_LOOKUP_CREDITS ?? '1', 10),
    webhookHostUrl: process.env.ENRICHLAYER_WEBHOOK_HOST_URL ?? '',  // e.g. https://api.butterbase.ai
  },

  /**
   * Platform DB env vars introduced in multi-region Phase 1.
   * In Phase 1, both URLs may point at the same database during initial deployment;
   * the failover script swaps the active URL via Fly secrets + process restart.
   * Backward compat: if NEON_PLATFORM_PRIMARY_URL is unset, fall back to CONTROL_DB_URL.
   */
  platformDb: {
    primaryUrl:
      process.env.NEON_PLATFORM_PRIMARY_URL ??
      process.env.CONTROL_DB_URL ??
      'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control',
    standbyUrl: process.env.NEON_PLATFORM_STANDBY_URL ?? '',
    /** Which side is currently active. Operator sets to 'standby' after a failover. */
    activeSide: ((): 'primary' | 'standby' => {
      const v = process.env.PLATFORM_DB_ACTIVE_SIDE ?? 'primary';
      if (v !== 'primary' && v !== 'standby') {
        throw new Error(`PLATFORM_DB_ACTIVE_SIDE must be 'primary' or 'standby', got: '${v}'`);
      }
      return v;
    })(),
  },

  runtimeDb: {
    urlsByRegion: {} as Record<string, string>,
  },

  dataPlaneDb: {
    host: process.env.DATA_PLANE_DB_HOST ?? 'localhost',
    port: parseInt(process.env.DATA_PLANE_DB_PORT ?? '5435', 10),
    user: process.env.DATA_PLANE_DB_USER ?? 'butterbase',
    password: process.env.DATA_PLANE_DB_PASSWORD ?? 'butterbase_dev',
  },

  pgbouncer: {
    host: process.env.PGBOUNCER_HOST ?? 'localhost',
    port: parseInt(process.env.PGBOUNCER_PORT ?? '6432', 10),
  },

  neon: {
    apiKey: process.env.NEON_API_KEY ?? '',
    dataProjectId: process.env.NEON_DATA_PROJECT_ID ?? '',
    /** Postgres role that owns per-app DBs; created via Neon API if missing on the branch */
    databaseOwner: process.env.NEON_DATA_DATABASE_OWNER ?? 'butterbase',
    enabled: process.env.NEON_API_KEY !== undefined && process.env.NEON_API_KEY !== '',
  },

  realtime: {
    maxListenConnections: parseInt(process.env.REALTIME_MAX_LISTEN_CONNECTIONS ?? '100', 10),
    /** Grace period (ms) before tearing down a LISTEN connection with no subscribers */
    teardownGraceMs: parseInt(process.env.REALTIME_TEARDOWN_GRACE_MS ?? '10000', 10),
    /** Interval (ms) between heartbeats sent to WebSocket clients */
    heartbeatIntervalMs: parseInt(process.env.REALTIME_HEARTBEAT_INTERVAL_MS ?? '30000', 10),
    /** Interval (ms) between cleanup runs for old change records */
    cleanupIntervalMs: parseInt(process.env.REALTIME_CLEANUP_INTERVAL_MS ?? '60000', 10),
  },

  runtimeUrl: process.env.DENO_RUNTIME_URL ?? 'http://deno-runtime:7133',

  /** Public-facing API base URL (used for api_base / function url fields returned to clients) */
  apiBaseUrl: process.env.API_BASE_URL ?? 'http://api.butterbase.local',

  dashboardUrl: process.env.DASHBOARD_URL ?? 'http://localhost:3000',
  adminDashboardUrl: process.env.ADMIN_DASHBOARD_URL ?? 'http://localhost:3001',
  submissionsDashboardUrl: process.env.SUBMISSIONS_DASHBOARD_URL ?? 'http://localhost:5173',

  subdomain: {
    baseDomain: process.env.BASE_DOMAIN ?? 'butterbase.dev',
    enabled: process.env.SUBDOMAIN_ROUTING_ENABLED !== 'false',
  },
  dashboardApiUrl: process.env.DASHBOARD_API_INTERNAL_URL ?? 'http://localhost:4100',

  sentry: {
    dsn: process.env.SENTRY_DSN ?? '',
    environment: process.env.NODE_ENV ?? 'development',
    enabled: !!process.env.SENTRY_DSN,
  },

  s3: {
    bucket: process.env.S3_BUCKET_NAME ?? 'butterbase-app-storage',
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT, // For LocalStack (internal)
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT, // For presigned URLs (browser-accessible)
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', // For LocalStack
    // AWS credentials are optional - AWS SDK will use IAM roles if credentials are not provided
    // In production, use IAM roles instead of explicit credentials for better security
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },

  adminSecret: process.env.ADMIN_SECRET ?? '',

  composio: {
    apiKey: process.env.COMPOSIO_API_KEY || '',
    stateSecret: process.env.COMPOSIO_STATE_SECRET || process.env.LOCAL_JWT_SECRET || 'dev-composio-state-secret',
  },

  ses: {
    region: resolveSesRegion(),
    // SES-only keys (separate from AWS_ACCESS_KEY_ID used for R2/S3). Optional: omit for default credential chain.
    accessKeyId: process.env.SES_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.SES_AWS_SECRET_ACCESS_KEY,
    fromEmail: process.env.SES_FROM_EMAIL ?? 'noreply@butterbase.com',
    fromName: process.env.SES_FROM_NAME ?? 'Butterbase',
  },

  cloudflare: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? '',
    enabled: !!process.env.CLOUDFLARE_ACCOUNT_ID && !!process.env.CLOUDFLARE_API_TOKEN,
    defaultDomain: process.env.CLOUDFLARE_DEFAULT_DOMAIN ?? 'butterbase.pages.dev',
    zoneId: process.env.CLOUDFLARE_ZONE_ID ?? '',
    dispatchNamespace: process.env.CLOUDFLARE_DISPATCH_NAMESPACE ?? 'bb-frontends',
    subdomainKvId: process.env.CLOUDFLARE_SUBDOMAIN_KV_ID ?? '',
    dispatchWorkerName: process.env.CLOUDFLARE_DISPATCH_WORKER_NAME ?? 'bb-dispatch',
    customHostnameFallbackOrigin: process.env.CLOUDFLARE_CUSTOM_HOSTNAME_FALLBACK ?? 'butterbase.dev',
  },

  deployment: {
    defaultBackend: process.env.DEPLOYMENT_DEFAULT_BACKEND === 'wfp' ? ('wfp' as const) : ('pages' as const),
  },

  partnerProxy: {
    enabled: process.env.PARTNER_PROXY_ENABLED === 'true',
  },

  buildRunner: {
    url: process.env.BUILD_RUNNER_URL ?? 'http://localhost:8788/build',
    sharedSecret: process.env.BUILD_RUNNER_SHARED_SECRET ?? 'dev-shared-secret',
  },
};

let runtimeDbAsserted = false;

export function assertRuntimeDbConfig(): void {
  if (runtimeDbAsserted) return;
  const regions = assertRegionConfig().regions;
  const map: Record<string, string> = {};
  for (const region of regions) {
    const envName = `NEON_RUNTIME_PROJECT_ID_${regionToEnvSuffix(region)}`;
    const value = process.env[envName];
    if (!value) {
      throw new Error(
        `Missing env var ${envName} (required because '${region}' is in BUTTERBASE_REGIONS).`
      );
    }
    map[region] = value;
  }
  config.runtimeDb.urlsByRegion = map;
  runtimeDbAsserted = true;
}

export function getLocalRuntimeUrl(): string {
  if (!runtimeDbAsserted) {
    throw new Error('assertRuntimeDbConfig() must be called before getLocalRuntimeUrl()');
  }
  const region = assertRegionConfig().instanceRegion;
  const url = config.runtimeDb.urlsByRegion[region];
  if (!url) {
    throw new Error(`No runtime DB URL for instance region ${region}`);
  }
  return url;
}
