import type { Pool } from 'pg';
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { decrypt } from './crypto.js';
import { config } from '../../config.js';
import { getRuntimeDbForApp } from '../region-resolver.js';
import { getProviderDefinition, type ProviderDefinition, type UserInfoResult } from './oauth-providers.js';
import { generateAppleClientSecret } from './apple-client-secret.js';

// Cache JWKS key sets per URL to avoid re-fetching on every request
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(url: string) {
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, jwks);
  }
  return jwks;
}

export interface ResolvedOAuthConfig {
  providerName: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationUrl: string;
  tokenUrl: string;
  userinfoUrl: string | null;
  scopes: string[];
  providerDef: ProviderDefinition | null;
  providerMetadata: Record<string, unknown>;
}

/**
 * Resolves OAuth config by merging DB config with provider registry defaults.
 * User-supplied values in DB take precedence over registry defaults.
 */
export async function resolveOAuthConfig(
  controlPool: Pool,
  appId: string,
  provider: string
): Promise<ResolvedOAuthConfig | null> {
  const runtimePool = await getRuntimeDbForApp(controlPool, appId);
  const result = await runtimePool.query(
    `SELECT client_id, client_secret_encrypted, redirect_uris, scopes,
            authorization_url, token_url, userinfo_url, enabled, provider_metadata
     FROM app_oauth_configs
     WHERE app_id = $1 AND provider = $2`,
    [appId, provider]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  if (!row.enabled) return null;

  const providerDef = getProviderDefinition(provider);
  const redirectUris: string[] = row.redirect_uris || [];

  if (redirectUris.length === 0) return null;

  // Decrypt client secret
  let clientSecret = '';
  if (row.client_secret_encrypted) {
    clientSecret = decrypt(row.client_secret_encrypted, config.auth.encryptionKey);
  }

  // For Apple, generate JWT client_secret from provider_metadata
  const metadata = (row.provider_metadata || {}) as Record<string, unknown>;
  if (providerDef?.requiresJwtClientSecret && metadata.teamId && metadata.keyId && metadata.privateKey) {
    clientSecret = await generateAppleClientSecret(
      row.client_id,
      String(metadata.teamId),
      String(metadata.keyId),
      String(metadata.privateKey)
    );
  }

  // Merge: user-supplied values override registry defaults
  const authorizationUrl = row.authorization_url || providerDef?.authorizationUrl || null;
  const tokenUrl = row.token_url || providerDef?.tokenUrl || null;
  const userinfoUrl = row.userinfo_url || providerDef?.userinfoUrl || null;
  const scopes = (row.scopes && row.scopes.length > 0) ? row.scopes : (providerDef?.defaultScopes || []);

  if (!authorizationUrl || !tokenUrl) return null;

  return {
    providerName: provider,
    clientId: row.client_id,
    clientSecret,
    redirectUri: redirectUris[0],
    authorizationUrl,
    tokenUrl,
    userinfoUrl,
    scopes,
    providerDef,
    providerMetadata: metadata,
  };
}

/**
 * Generates PKCE code_verifier and code_challenge if the provider requires it.
 */
export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Builds the authorization URL with all provider-specific params.
 */
export function buildAuthorizationUrl(
  resolved: ResolvedOAuthConfig,
  state: string,
  codeChallenge?: string
): string {
  const def = resolved.providerDef;
  const url = new URL(resolved.authorizationUrl);

  url.searchParams.set('client_id', resolved.clientId);
  url.searchParams.set('redirect_uri', resolved.redirectUri);
  url.searchParams.set('response_type', def?.responseType || 'code');
  url.searchParams.set('state', state);

  // Scopes
  const separator = def?.scopeSeparator || ' ';
  if (resolved.scopes.length > 0) {
    url.searchParams.set('scope', resolved.scopes.join(separator));
  }

  // Response mode (Apple uses form_post)
  if (def?.responseMode) {
    url.searchParams.set('response_mode', def.responseMode);
  }

  // PKCE
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }

  // Extra auth params (e.g., Google's access_type=offline)
  if (def?.extraAuthParams) {
    for (const [key, value] of Object.entries(def.extraAuthParams)) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

/**
 * Exchanges authorization code for tokens, handling provider-specific quirks.
 */
export async function exchangeCodeForTokens(
  resolved: ResolvedOAuthConfig,
  code: string,
  codeVerifier?: string
): Promise<{ accessToken: string; idToken?: string }> {
  const def = resolved.providerDef;

  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    client_id: resolved.clientId,
    redirect_uri: resolved.redirectUri,
  };

  // Add client_secret to body unless using Basic auth
  if (def?.tokenExchangeAuthMethod !== 'basic') {
    params.client_secret = resolved.clientSecret;
  }

  // PKCE verifier
  if (codeVerifier) {
    params.code_verifier = codeVerifier;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
  };

  // Basic auth (X/Twitter)
  if (def?.tokenExchangeAuthMethod === 'basic') {
    const credentials = Buffer.from(`${resolved.clientId}:${resolved.clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  }

  const response = await fetch(resolved.tokenUrl, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as Record<string, unknown>;

  return {
    accessToken: String(data.access_token || ''),
    idToken: data.id_token ? String(data.id_token) : undefined,
  };
}

/**
 * Extracts user info from tokens, handling ID token verification and provider-specific userinfo endpoints.
 */
export async function extractUserInfo(
  resolved: ResolvedOAuthConfig,
  tokens: { accessToken: string; idToken?: string }
): Promise<UserInfoResult> {
  const def = resolved.providerDef;

  // Try ID token verification first (Google, LinkedIn, Apple)
  if (def?.idTokenVerification?.useIdTokenForUserinfo && tokens.idToken && def.mapIdTokenClaims) {
    const jwks = getJWKS(def.idTokenVerification.jwksUrl);
    const { payload } = await jwtVerify(tokens.idToken, jwks, {
      issuer: def.idTokenVerification.issuer,
      audience: resolved.clientId,
    });
    return def.mapIdTokenClaims(payload as Record<string, unknown>);
  }

  // Fall back to userinfo endpoint
  if (!resolved.userinfoUrl) {
    throw new Error('No userinfo URL configured and no ID token available');
  }

  const userinfoUrl = new URL(resolved.userinfoUrl);

  // Add query params (Facebook fields, X user.fields)
  if (def?.userinfoQueryParams) {
    for (const [key, value] of Object.entries(def.userinfoQueryParams)) {
      userinfoUrl.searchParams.set(key, value);
    }
  }

  const userinfoResponse = await fetch(userinfoUrl.toString(), {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
    },
  });

  if (!userinfoResponse.ok) {
    throw new Error(`Userinfo fetch failed (${userinfoResponse.status})`);
  }

  const userinfo = await userinfoResponse.json() as Record<string, unknown>;

  // Use provider-specific mapping if available
  if (def?.mapUserinfo) {
    const result = def.mapUserinfo(userinfo);

    // GitHub email fallback: if email is missing, try /user/emails
    if (!result.email && def.emailFallback) {
      const emailResponse = await fetch(def.emailFallback.url, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      if (emailResponse.ok) {
        const emailData = await emailResponse.json();
        result.email = def.emailFallback.extractEmail(emailData);
      }
    }

    return result;
  }

  // Generic mapping for unknown providers
  return {
    providerUid: String(userinfo.sub || userinfo.id || ''),
    email: String(userinfo.email || ''),
    displayName: String(userinfo.name || userinfo.display_name || ''),
    avatarUrl: String(userinfo.picture || userinfo.avatar_url || ''),
  };
}
