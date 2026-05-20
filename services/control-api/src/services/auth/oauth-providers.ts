/**
 * OAuth Provider Registry
 *
 * Hardcoded defaults for known OAuth providers. When a user configures a known
 * provider, they only need client_id, client_secret, and redirect_uris — the
 * rest is auto-filled from this registry.
 */

export type KnownProvider = 'google' | 'github' | 'discord' | 'facebook' | 'linkedin' | 'microsoft' | 'apple' | 'x';

export interface UserInfoResult {
  providerUid: string;
  email: string;
  displayName: string;
  avatarUrl: string;
}

export interface IdTokenVerificationConfig {
  jwksUrl: string;
  issuer: string;
  /** If true, extract user info from ID token claims instead of calling userinfo endpoint */
  useIdTokenForUserinfo: boolean;
}

export interface EmailFallbackConfig {
  url: string;
  extractEmail: (data: unknown) => string;
}

export interface ProviderDefinition {
  authorizationUrl: string;
  tokenUrl: string;
  /** null for providers that use ID token verification instead of userinfo endpoint */
  userinfoUrl: string | null;

  defaultScopes: string[];
  /** Facebook uses comma, everyone else uses space */
  scopeSeparator: ' ' | ',';

  /** How to send credentials in token exchange */
  tokenExchangeAuthMethod: 'body' | 'basic';

  /** Map provider-specific userinfo response to standard format */
  mapUserinfo: (data: Record<string, unknown>) => UserInfoResult;

  /** Map ID token claims to standard format (for providers using JWKS verification) */
  mapIdTokenClaims?: (claims: Record<string, unknown>) => UserInfoResult;

  /** PKCE requirement */
  pkce?: 'S256';

  /** Override response_type (default: 'code') */
  responseType?: string;

  /** Apple uses form_post */
  responseMode?: 'form_post';

  /** Extra query params on authorization URL */
  extraAuthParams?: Record<string, string>;

  /** Apple requires a JWT client_secret */
  requiresJwtClientSecret?: boolean;

  /** ID token verification via JWKS */
  idTokenVerification?: IdTokenVerificationConfig;

  /** Fallback endpoint for email (GitHub) */
  emailFallback?: EmailFallbackConfig;

  /** Extra query params on userinfo request (Facebook fields, X user.fields) */
  userinfoQueryParams?: Record<string, string>;
}

export const KNOWN_PROVIDERS: Record<KnownProvider, ProviderDefinition> = {
  google: {
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    defaultScopes: ['openid', 'email', 'profile'],
    scopeSeparator: ' ',
    tokenExchangeAuthMethod: 'body',
    extraAuthParams: { access_type: 'offline' },
    idTokenVerification: {
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuer: 'https://accounts.google.com',
      useIdTokenForUserinfo: true,
    },
    mapIdTokenClaims: (claims) => ({
      providerUid: String(claims.sub || ''),
      email: String(claims.email || ''),
      displayName: String(claims.name || ''),
      avatarUrl: String(claims.picture || ''),
    }),
    mapUserinfo: (data) => ({
      providerUid: String(data.sub || ''),
      email: String(data.email || ''),
      displayName: String(data.name || ''),
      avatarUrl: String(data.picture || ''),
    }),
  },

  github: {
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfoUrl: 'https://api.github.com/user',
    defaultScopes: ['user:email'],
    scopeSeparator: ' ',
    tokenExchangeAuthMethod: 'body',
    emailFallback: {
      url: 'https://api.github.com/user/emails',
      extractEmail: (data: unknown) => {
        const emails = data as Array<{ email: string; primary: boolean }>;
        const primary = emails.find((e) => e.primary);
        return primary ? primary.email : emails[0]?.email || '';
      },
    },
    mapUserinfo: (data) => ({
      providerUid: String(data.id || ''),
      email: String(data.email || ''),
      displayName: String(data.name || data.login || ''),
      avatarUrl: String(data.avatar_url || ''),
    }),
  },

  discord: {
    authorizationUrl: 'https://discord.com/api/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userinfoUrl: 'https://discord.com/api/users/@me',
    defaultScopes: ['identify', 'email'],
    scopeSeparator: ' ',
    tokenExchangeAuthMethod: 'body',
    mapUserinfo: (data) => {
      const avatarHash = data.avatar as string | null;
      const id = String(data.id || '');
      const avatarUrl = avatarHash
        ? `https://cdn.discordapp.com/avatars/${id}/${avatarHash}.png`
        : '';
      return {
        providerUid: id,
        email: String(data.email || `${id}@users.noreply.discord.local`),
        displayName: String(data.global_name || data.username || ''),
        avatarUrl,
      };
    },
  },

  facebook: {
    authorizationUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
    userinfoUrl: 'https://graph.facebook.com/v21.0/me',
    defaultScopes: ['email', 'public_profile'],
    scopeSeparator: ',',
    tokenExchangeAuthMethod: 'body',
    userinfoQueryParams: { fields: 'id,email,name,first_name,last_name,picture' },
    mapUserinfo: (data) => {
      const picture = data.picture as { data?: { url?: string } } | undefined;
      return {
        providerUid: String(data.id || ''),
        email: String(data.email || ''),
        displayName: String(data.name || data.first_name || ''),
        avatarUrl: picture?.data?.url || '',
      };
    },
  },

  linkedin: {
    authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    userinfoUrl: null,
    defaultScopes: ['openid', 'profile', 'email'],
    scopeSeparator: ' ',
    tokenExchangeAuthMethod: 'body',
    idTokenVerification: {
      jwksUrl: 'https://www.linkedin.com/oauth/openid/jwks',
      issuer: 'https://www.linkedin.com/oauth',
      useIdTokenForUserinfo: true,
    },
    mapIdTokenClaims: (claims) => ({
      providerUid: String(claims.sub || ''),
      email: String(claims.email || ''),
      displayName: String(claims.name || ''),
      avatarUrl: String(claims.picture || ''),
    }),
    mapUserinfo: (data) => ({
      providerUid: String(data.sub || ''),
      email: String(data.email || ''),
      displayName: String(data.name || ''),
      avatarUrl: String(data.picture || ''),
    }),
  },

  microsoft: {
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userinfoUrl: 'https://graph.microsoft.com/v1.0/me',
    defaultScopes: ['openid', 'email', 'profile', 'User.Read'],
    scopeSeparator: ' ',
    tokenExchangeAuthMethod: 'body',
    mapUserinfo: (data) => ({
      providerUid: String(data.id || ''),
      email: String(data.mail || data.userPrincipalName || ''),
      displayName: String(data.displayName || ''),
      avatarUrl: '',
    }),
  },

  apple: {
    authorizationUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    userinfoUrl: null,
    defaultScopes: ['name', 'email'],
    scopeSeparator: ' ',
    tokenExchangeAuthMethod: 'body',
    responseType: 'code id_token',
    responseMode: 'form_post',
    requiresJwtClientSecret: true,
    idTokenVerification: {
      jwksUrl: 'https://appleid.apple.com/auth/keys',
      issuer: 'https://appleid.apple.com',
      useIdTokenForUserinfo: true,
    },
    mapIdTokenClaims: (claims) => ({
      providerUid: String(claims.sub || ''),
      email: String(claims.email || ''),
      displayName: String(claims.email ? (claims.email as string).split('@')[0] : ''),
      avatarUrl: '',
    }),
    mapUserinfo: (data) => ({
      providerUid: String(data.sub || ''),
      email: String(data.email || ''),
      displayName: String(data.email ? (data.email as string).split('@')[0] : ''),
      avatarUrl: '',
    }),
  },

  x: {
    authorizationUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    userinfoUrl: 'https://api.twitter.com/2/users/me',
    defaultScopes: ['tweet.read', 'users.read'],
    scopeSeparator: ' ',
    tokenExchangeAuthMethod: 'basic',
    pkce: 'S256',
    userinfoQueryParams: { 'user.fields': 'id,name,username,profile_image_url' },
    mapUserinfo: (data) => {
      // X wraps user data under a "data" key
      const user = (data.data || data) as Record<string, unknown>;
      const username = String(user.username || user.name || '');
      return {
        providerUid: String(user.id || ''),
        email: `${username}@users.noreply.x.local`,
        displayName: String(user.name || username),
        avatarUrl: String(user.profile_image_url || ''),
      };
    },
  },
};

export function isKnownProvider(name: string): name is KnownProvider {
  return name in KNOWN_PROVIDERS;
}

/**
 * Returns the provider definition for a known provider, or null for custom providers.
 */
export function getProviderDefinition(name: string): ProviderDefinition | null {
  return isKnownProvider(name) ? KNOWN_PROVIDERS[name] : null;
}
