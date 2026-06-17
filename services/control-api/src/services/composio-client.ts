// services/control-api/src/services/composio-client.ts
import { Composio } from '@composio/core';
import { createHmac, randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { config } from '../config.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { getRuntimeDbPool } from './runtime-db.js';

// Curated integrations with first-class support
export const CURATED_TOOLKITS = [
  'gmail', 'google-calendar', 'slack', 'google-sheets',
  'notion', 'github', 'hubspot', 'outlook', 'google-drive', 'discord',
] as const;

export interface IntegrationConfig {
  id: string;
  app_id: string;
  toolkit_slug: string;
  composio_auth_config_id: string;
  display_name: string | null;
  enabled: boolean;
  scopes: string[];
  created_at: string;
}

export interface ConnectedAccount {
  id: string;
  app_id: string;
  app_user_id: string;
  toolkit_slug: string;
  composio_account_id: string;
  status: 'active' | 'inactive' | 'expired';
  connected_at: string;
  last_used_at: string | null;
}

// ==========================================
// State token utilities for OAuth callback
// ==========================================

/**
 * Create a signed HMAC state token for the OAuth callback.
 * The token encodes identity (appId, userId, toolkit, redirectUrl) so
 * the callback handler can record the connection without a pending table.
 * This avoids the race condition of looking up "most recent pending connection."
 */
export function createStateToken(
  payload: { appId: string; userId: string; toolkit: string; redirectUrl: string },
  ttlMs = 30 * 60 * 1000,
): string {
  // Nonce ensures two flows for the same user+toolkit produce different tokens
  const data = { ...payload, nonce: randomUUID(), exp: Date.now() + ttlMs };
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = createHmac('sha256', config.composio.stateSecret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

/**
 * Verify and decode a state token. Returns null if invalid or expired.
 */
export function verifyStateToken(
  token: string,
): { appId: string; userId: string; toolkit: string; redirectUrl: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = createHmac('sha256', config.composio.stateSecret).update(encoded).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// ==========================================
// Composio client helpers
// ==========================================

let __composioOverride: Composio | null = null;

/** Test-only: override the Composio client. Pass `null` to clear. */
export function __setComposioClientForTest(client: Composio | null): void {
  __composioOverride = client;
}

/**
 * Get the platform-level Composio client.
 * One API key for all of Butterbase. User isolation is achieved
 * by namespacing user IDs as `{appId}_{endUserId}`.
 */
export function getComposioClient(): Composio {
  if (__composioOverride) return __composioOverride;
  if (!config.composio.apiKey) {
    throw Object.assign(
      new Error('Composio API key not configured. Set COMPOSIO_API_KEY environment variable.'),
      { code: 'INTEGRATIONS_NOT_CONFIGURED' },
    );
  }
  return new Composio({ apiKey: config.composio.apiKey });
}

/**
 * Build a Composio-scoped user ID from app + end-user.
 * This is the isolation boundary — Composio scopes all connections
 * and tool executions to this user ID.
 */
function composioUserId(appId: string, userId: string): string {
  return `${appId}_${userId}`;
}

// ==========================================
// Integration config (admin operations)
// ==========================================

/**
 * Map a Composio SDK error from authConfigs.create() to a Butterbase
 * domain error. The Composio SDK throws errors with .status / .message
 * (and sometimes .code) — we sniff the message for the well-known
 * "managed auth not available" signal and surface a 400 with remediation;
 * otherwise we wrap as INTEGRATIONS_UPSTREAM_ERROR (502) so the caller
 * doesn't see a generic INTERNAL_ERROR.
 */
function mapComposioAuthConfigError(err: any, toolkit: string, byo: boolean): Error {
  const rawMsg: string = err?.message || err?.error?.message || String(err);
  const status: number | undefined = err?.status ?? err?.statusCode ?? err?.response?.status;
  const lower = rawMsg.toLowerCase();
  const managedUnavailable =
    !byo && (
      lower.includes('managed auth') ||
      lower.includes('use_composio_managed_auth') ||
      lower.includes('no auth config') ||
      lower.includes('not supported') ||
      lower.includes('not available') ||
      lower.includes('credentials are required') ||
      status === 404
    );
  if (managedUnavailable) {
    return Object.assign(
      new Error(
        `Toolkit "${toolkit}" does not have Composio-managed OAuth credentials. ` +
        `Provide oauth_credentials.{client_id, client_secret} when calling configure.`,
      ),
      { code: 'INTEGRATIONS_BYO_CREDENTIALS_REQUIRED', upstreamMessage: rawMsg, upstreamStatus: status },
    );
  }
  return Object.assign(
    new Error(`Composio rejected the auth config for "${toolkit}": ${rawMsg}`),
    { code: 'INTEGRATIONS_UPSTREAM_ERROR', upstreamMessage: rawMsg, upstreamStatus: status },
  );
}

export type OAuthCredentials = {
  client_id: string;
  client_secret: string;
  /** Composio auth scheme. Defaults to 'OAUTH2'. Stripped before forwarding. */
  auth_scheme?:
    | 'OAUTH2' | 'OAUTH1' | 'API_KEY' | 'BASIC' | 'BILLCOM_AUTH' | 'BEARER_TOKEN'
    | 'GOOGLE_SERVICE_ACCOUNT' | 'NO_AUTH' | 'BASIC_WITH_JWT' | 'CALCOM_AUTH'
    | 'SERVICE_ACCOUNT' | 'SAML' | 'DCR_OAUTH' | 'S2S_OAUTH2';
  /** Any additional credential fields the toolkit requires (e.g. twitter's `generic_id`). */
  [key: string]: string | number | boolean | undefined;
};

/**
 * Configure an integration for an app.
 * Creates a Composio auth config (or returns existing one).
 *
 * If `oauthCredentials` is provided, registers a use_custom_auth config with the
 * caller's OAuth client_id/client_secret (BYO). Otherwise, asks Composio to use
 * its managed auth — which only works for toolkits Composio has provisioned
 * client credentials for. Non-curated toolkits without managed auth fail here
 * and surface as INTEGRATIONS_BYO_CREDENTIALS_REQUIRED.
 */
export async function configureIntegration(
  controlDb: Pool,
  appId: string,
  toolkit: string,
  scopes?: string[],
  displayName?: string,
  oauthCredentials?: OAuthCredentials,
): Promise<IntegrationConfig> {
  const composio = getComposioClient();
  const runtimePool = await getRuntimeDbForApp(controlDb, appId);

  // Check if already configured
  const existing = await runtimePool.query(
    'SELECT * FROM app_integration_configs WHERE app_id = $1 AND toolkit_slug = $2',
    [appId, toolkit],
  );

  if (existing.rows.length > 0 && existing.rows[0].enabled) {
    return existing.rows[0];
  }

  // Composio authConfigs.create requires uppercase slug with hyphens removed (e.g. "GOOGLECALENDAR", "GITHUB")
  const composioSlug = toolkit.toUpperCase().replace(/-/g, '');
  let authConfig: { id?: string };
  try {
    if (oauthCredentials) {
      const { auth_scheme: authSchemeOpt, ...rest } = oauthCredentials;
      const authScheme = authSchemeOpt ?? 'OAUTH2';
      const credentials: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) credentials[k] = v;
      }
      if (scopes && scopes.length && credentials.scopes === undefined) {
        credentials.scopes = scopes.join(',');
      }
      authConfig = await composio.authConfigs.create(composioSlug, {
        type: 'use_custom_auth',
        authScheme,
        credentials,
        name: `${appId}_${toolkit}`,
      } as any);
    } else {
      authConfig = await composio.authConfigs.create(composioSlug, {
        type: 'use_composio_managed_auth',
        name: `${appId}_${toolkit}`,
      });
    }
  } catch (err: any) {
    throw mapComposioAuthConfigError(err, toolkit, !!oauthCredentials);
  }

  const authConfigId = authConfig.id ?? '';

  // Store in our DB (app_integration_configs is runtime-tier)
  const result = await runtimePool.query(
    `INSERT INTO app_integration_configs (app_id, toolkit_slug, composio_auth_config_id, display_name, scopes)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (app_id, toolkit_slug)
     DO UPDATE SET composio_auth_config_id = EXCLUDED.composio_auth_config_id,
       display_name = COALESCE(EXCLUDED.display_name, app_integration_configs.display_name),
       scopes = EXCLUDED.scopes,
       enabled = true, updated_at = now()
     RETURNING *`,
    [appId, toolkit, authConfigId, displayName || null, JSON.stringify(scopes || [])],
  );

  return result.rows[0];
}

/**
 * Rotate the BYO OAuth credentials on an existing integration.
 *
 * Preserves the Composio auth_config_id (and therefore all existing
 * connected accounts that reference it) while swapping in new
 * client_id/client_secret. Use when the OAuth client is rotated by the
 * upstream provider — call this instead of disable+configure, which
 * would orphan every connected account.
 *
 * The toolkit must already be configured. If it isn't, throws
 * INTEGRATIONS_TOOLKIT_NOT_ENABLED.
 */
export async function rotateIntegrationCredentials(
  controlDb: Pool,
  appId: string,
  toolkit: string,
  oauthCredentials: OAuthCredentials,
): Promise<IntegrationConfig> {
  const composio = getComposioClient();
  const runtimePool = await getRuntimeDbForApp(controlDb, appId);

  const existing = await runtimePool.query(
    'SELECT * FROM app_integration_configs WHERE app_id = $1 AND toolkit_slug = $2',
    [appId, toolkit],
  );
  if (existing.rows.length === 0) {
    throw Object.assign(
      new Error(`Integration "${toolkit}" is not configured for this app`),
      { code: 'INTEGRATIONS_TOOLKIT_NOT_ENABLED' },
    );
  }

  const authConfigId: string = existing.rows[0].composio_auth_config_id;
  if (!authConfigId) {
    throw Object.assign(
      new Error(`Integration "${toolkit}" has no Composio auth_config_id; reconfigure with oauth_credentials instead`),
      { code: 'INTEGRATIONS_BYO_CREDENTIALS_REQUIRED' },
    );
  }

  const { auth_scheme: _ignored, ...rest } = oauthCredentials;
  const credentials: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) credentials[k] = v;
  }

  try {
    await composio.authConfigs.update(authConfigId, {
      type: 'custom',
      credentials,
    } as any);
  } catch (err: any) {
    throw mapComposioAuthConfigError(err, toolkit, true);
  }

  const result = await runtimePool.query(
    `UPDATE app_integration_configs
       SET updated_at = now(), enabled = true
     WHERE app_id = $1 AND toolkit_slug = $2
     RETURNING *`,
    [appId, toolkit],
  );
  return result.rows[0];
}

/**
 * List configured integrations for an app.
 */
export async function listIntegrationConfigs(
  controlDb: Pool,
  appId: string,
): Promise<IntegrationConfig[]> {
  const runtimePool = await getRuntimeDbForApp(controlDb, appId);
  const result = await runtimePool.query(
    'SELECT * FROM app_integration_configs WHERE app_id = $1 AND enabled = true ORDER BY created_at',
    [appId],
  );
  return result.rows;
}

/**
 * Disable an integration for an app.
 * Uses authConfigs.disable() in Composio to prevent new connections
 * while preserving existing end-user connections (they keep working
 * until tokens expire). This is safer than authConfigs.delete() which
 * would orphan all connected accounts.
 */
export async function disableIntegration(
  controlDb: Pool,
  appId: string,
  toolkit: string,
): Promise<void> {
  const runtimePool = await getRuntimeDbForApp(controlDb, appId);

  // Get the auth config ID before disabling
  const existing = await runtimePool.query(
    'SELECT composio_auth_config_id FROM app_integration_configs WHERE app_id = $1 AND toolkit_slug = $2',
    [appId, toolkit],
  );

  await runtimePool.query(
    `UPDATE app_integration_configs SET enabled = false, updated_at = now()
     WHERE app_id = $1 AND toolkit_slug = $2`,
    [appId, toolkit],
  );

  // Best-effort: disable the auth config in Composio (prevents new connections,
  // keeps existing ones alive)
  if (existing.rows.length > 0) {
    try {
      const composio = getComposioClient();
      await composio.authConfigs.disable(existing.rows[0].composio_auth_config_id);
    } catch {
      // Best-effort cleanup — auth config may already be disabled/deleted
    }
  }
}

// ==========================================
// OAuth connection flow
// ==========================================

/**
 * Initiate an OAuth connection for an end-user.
 * Returns the redirect URL for the user to complete OAuth.
 *
 * Uses a signed HMAC state token in the callback URL instead of a
 * pending-connections table. This is race-free: the callback can
 * identify the user from the state token + connectedAccountId that
 * Composio appends to the callback URL.
 */
export async function initiateConnection(
  controlDb: Pool,
  appId: string,
  userId: string,
  toolkit: string,
  redirectUrl: string,
): Promise<{ authUrl: string; connectionRequestId: string }> {
  const runtimePool = await getRuntimeDbForApp(controlDb, appId);

  // Verify toolkit is enabled for this app
  const configResult = await runtimePool.query(
    'SELECT composio_auth_config_id FROM app_integration_configs WHERE app_id = $1 AND toolkit_slug = $2 AND enabled = true',
    [appId, toolkit],
  );
  if (configResult.rows.length === 0) {
    throw Object.assign(
      new Error(`Integration "${toolkit}" is not enabled for this app`),
      { code: 'INTEGRATIONS_TOOLKIT_NOT_ENABLED' },
    );
  }

  const authConfigId = configResult.rows[0].composio_auth_config_id;
  const composio = getComposioClient();
  const cUserId = composioUserId(appId, userId);

  // Create signed state token with identity info
  const state = createStateToken({ appId, userId, toolkit, redirectUrl });

  // Composio preserves query params on the callbackUrl and appends
  // status=success&connectedAccountId=ca_xxx on successful OAuth
  const callbackUrl = `${config.apiBaseUrl}/v1/${appId}/integrations/callback?state=${encodeURIComponent(state)}`;

  const connRequest = await composio.connectedAccounts.initiate(cUserId, authConfigId, {
    callbackUrl,
  });

  return {
    authUrl: connRequest.redirectUrl || '',
    connectionRequestId: connRequest.id,
  };
}

/**
 * Record a completed OAuth connection.
 * Called from the callback route after verifying the state token.
 * By the time Composio redirects to the callback, the connection
 * is already active — no polling/waitForConnection needed.
 */
export async function recordConnection(
  controlDb: Pool,
  appId: string,
  userId: string,
  toolkit: string,
  composioAccountId: string,
): Promise<ConnectedAccount> {
  // app_connected_accounts is a runtime-tier table — use runtimePool
  const runtimePool = await getRuntimeDbForApp(controlDb, appId);
  const result = await runtimePool.query(
    `INSERT INTO app_connected_accounts (app_id, app_user_id, toolkit_slug, composio_account_id, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (app_id, app_user_id, toolkit_slug)
     DO UPDATE SET composio_account_id = EXCLUDED.composio_account_id, status = 'active',
       connected_at = now(), last_used_at = null
     RETURNING *`,
    [appId, userId, toolkit, composioAccountId],
  );
  return result.rows[0];
}

// ==========================================
// Connected accounts management
// ==========================================

/**
 * List connected accounts for a user.
 */
export async function listConnectedAccounts(
  controlDb: Pool,
  appId: string,
  userId: string,
): Promise<ConnectedAccount[]> {
  // app_connected_accounts is a runtime-tier table — use runtimePool
  const runtimePool = await getRuntimeDbForApp(controlDb, appId);
  const result = await runtimePool.query(
    `SELECT * FROM app_connected_accounts
     WHERE app_id = $1 AND app_user_id = $2 AND status = 'active'
     ORDER BY connected_at`,
    [appId, userId],
  );
  return result.rows;
}

/**
 * List all connected accounts for an app (admin view).
 */
export async function listAllConnectedAccounts(
  controlDb: Pool,
  appId: string,
): Promise<ConnectedAccount[]> {
  // app_connected_accounts is a runtime-tier table — use runtimePool
  const runtimePool = await getRuntimeDbForApp(controlDb, appId);
  const result = await runtimePool.query(
    'SELECT * FROM app_connected_accounts WHERE app_id = $1 ORDER BY connected_at',
    [appId],
  );
  return result.rows;
}

/**
 * Disconnect an account.
 */
export async function disconnectAccount(
  controlDb: Pool,
  appId: string,
  userId: string,
  connectionId: string,
): Promise<void> {
  // app_connected_accounts is a runtime-tier table — use runtimePool
  const runtimePool = await getRuntimeDbForApp(controlDb, appId);

  // Verify ownership and get Composio account ID
  const result = await runtimePool.query(
    'SELECT composio_account_id FROM app_connected_accounts WHERE id = $1 AND app_id = $2 AND app_user_id = $3',
    [connectionId, appId, userId],
  );
  if (result.rows.length === 0) {
    throw Object.assign(new Error('Connection not found'), { code: 'RESOURCE_NOT_FOUND' });
  }

  // Delete from Composio
  const composio = getComposioClient();
  try {
    await composio.connectedAccounts.delete(result.rows[0].composio_account_id);
  } catch {
    // Best-effort Composio cleanup — proceed with local deletion
  }

  // Remove from our DB (app_connected_accounts is runtime-tier)
  await runtimePool.query('DELETE FROM app_connected_accounts WHERE id = $1', [connectionId]);
}

// ==========================================
// Integration discovery
// ==========================================

export interface ToolkitListing {
  toolkit: string;
  displayName: string;
  curated: boolean;
  /** Auth schemes supported by the toolkit (e.g. ["OAUTH2", "API_KEY"]). */
  auth_schemes: string[];
  /**
   * True if the toolkit has NO Composio-managed credentials available
   * (caller must supply oauth_credentials when calling configure).
   * False if Composio can issue managed credentials for at least one scheme.
   */
  requires_byo_credentials: boolean;
}

function projectToolkit(t: any): ToolkitListing {
  const slug = (t?.slug || '').toLowerCase();
  const managedSchemes: string[] = Array.isArray(t?.composioManagedAuthSchemes)
    ? t.composioManagedAuthSchemes : [];
  const detailModes: string[] = Array.isArray(t?.authConfigDetails)
    ? t.authConfigDetails.map((d: any) => d?.mode).filter(Boolean) : [];
  const authSchemes = detailModes.length ? detailModes : managedSchemes;
  return {
    toolkit: slug,
    displayName: t?.name || t?.slug || '',
    curated: CURATED_TOOLKITS.includes(slug as any),
    auth_schemes: authSchemes,
    requires_byo_credentials: managedSchemes.length === 0,
  };
}

/**
 * Search the Composio catalog for available integrations.
 * Uses composio.toolkits.list() which returns toolkit-level metadata
 * (slug, name) without per-tool fan-out — cleaner than getRawComposioTools + dedup.
 */
export async function searchToolkits(
  search: string,
): Promise<ToolkitListing[]> {
  const composio = getComposioClient();
  // toolkits.get(params) returns a paginated list; the SDK doesn't support
  // free-text search, so we fetch a page and filter client-side.
  const result = await composio.toolkits.get({ limit: 100 });
  // SDK returns an array directly (not { items: [] })
  const items: any[] = Array.isArray(result) ? result : ((result as any)?.items || []);
  const query = search.toLowerCase();
  return items
    .filter((t: any) => {
      const slug = (t.slug || '').toLowerCase();
      const name = (t.name || '').toLowerCase();
      return slug.includes(query) || name.includes(query);
    })
    .slice(0, 20)
    .map(projectToolkit);
}

// ==========================================
// Tool discovery and execution
// ==========================================

/**
 * Get available tools for a user's connected integrations.
 * Uses getRawComposioTools() which returns raw metadata with
 * .slug, .description, .inputParameters (JSON Schema).
 *
 * NOTE: Do NOT use composio.tools.get() — it returns OpenAI
 * function-calling shaped objects, not raw tool metadata.
 */
export async function getToolsForUser(
  _controlDb: Pool,
  appId: string,
  userId: string,
  toolkit?: string,
): Promise<Array<{ name: string; description: string; parameters: Record<string, unknown> }>> {
  const composio = getComposioClient();

  const options: Record<string, unknown> = { limit: 50 };
  if (toolkit) {
    options.toolkits = [toolkit];
  }

  const rawTools = await composio.tools.getRawComposioTools(options as any);

  return rawTools.map((tool: any) => ({
    name: tool.slug,
    description: tool.description || '',
    parameters: tool.inputParameters || {},
  }));
}

/**
 * Execute a tool action for a user.
 * Uses composio.tools.execute() which returns { successful, data, error }.
 *
 * Distinguishes between:
 * - Thrown errors (SDK/network failures) → sets `thrown: true`
 * - Soft failures (upstream 400, quota, etc.) → `successful: false` from Composio
 */
export async function executeTool(
  controlDb: Pool,
  appId: string,
  userId: string,
  toolName: string,
  params: Record<string, unknown>,
): Promise<{ successful: boolean; data: unknown; error?: string; thrown?: boolean }> {
  const composio = getComposioClient();
  const cUserId = composioUserId(appId, userId);
  // app_connected_accounts is a runtime-tier table — use runtimePool
  const runtimePool = await getRuntimeDbForApp(controlDb, appId);

  try {
    const result = await composio.tools.execute(toolName, {
      userId: cUserId,
      arguments: params,
      dangerouslySkipVersionCheck: true,
    });

    // Update last_used_at (app_connected_accounts is runtime-tier)
    await runtimePool.query(
      `UPDATE app_connected_accounts SET last_used_at = now()
       WHERE app_id = $1 AND app_user_id = $2`,
      [appId, userId],
    );

    return {
      successful: result.successful ?? false,
      data: result.data ?? null,
      error: result.error ?? undefined,
    };
  } catch (error: any) {
    return { successful: false, data: null, error: error.message, thrown: true };
  }
}
