import type { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import { KvCredentialsService } from '../kv-credentials.js';
import { verifyEndUserJwt } from '../end-user-auth.js';
import type { AuthProvider } from '../auth-provider.js';

// ---------------------------------------------------------------------------
// Identity shapes
// ---------------------------------------------------------------------------

export interface AnonIdentity {
  kind: 'anon';
}

export interface JwtIdentity {
  kind: 'jwt';
  userId: string;
  role: string | null;
}

export interface ApiKeyIdentity {
  kind: 'apiKey';
}

export interface FunctionIdentity {
  kind: 'function';
}

export type KvIdentity = AnonIdentity | JwtIdentity | ApiKeyIdentity | FunctionIdentity;

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface KvAuthSuccess {
  appId: string;
  region: string;
  redisPassword: string;
  identity: KvIdentity;
  /** true for apiKey + function; false for jwt + anon */
  allowExposeWrites: boolean;
}

export interface KvAuthFailure {
  error: 'auth_failed';
  status: number;
  body: Record<string, string>;
}

export type KvAuthResult = KvAuthSuccess | KvAuthFailure;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isJwtShape(bearer: string): boolean {
  // A JWT has exactly 2 dots (header.payload.sig = 3 segments)
  const parts = bearer.split('.');
  return parts.length === 3;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Ported from kv-gateway/src/auth.ts.
 * Resolves auth from an inbound request's Authorization header using
 * direct service-method calls (no HTTP round-trip to control-api).
 *
 * Decision order:
 *   1. No Authorization header  → anon (shared redis creds, no writes exposed)
 *   2. Bearer with 2 dots       → JWT  (verifyEndUserJwt)
 *   3. Bearer without dots      → try function key first, then dev API key
 *   4. Nothing matched          → 403
 */
export async function resolveKvAuth(
  controlDb: Pool,
  appId: string,
  req: Pick<FastifyRequest, 'headers'>,
  authProvider?: AuthProvider,
): Promise<KvAuthResult> {
  const svc = new KvCredentialsService(controlDb);

  const authHeader = req.headers['authorization'] as string | undefined;

  // ------------------------------------------------------------------
  // 1. No header → anon
  // ------------------------------------------------------------------
  if (!authHeader) {
    const creds = await svc.anonCredentialsFor(appId);
    if (!creds) {
      return { error: 'auth_failed', status: 404, body: { error: 'no_kv_credential' } };
    }
    return {
      appId: creds.app_id,
      region: creds.region,
      redisPassword: creds.redis_password,
      identity: { kind: 'anon' },
      allowExposeWrites: false,
    };
  }

  const bearer = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : authHeader.trim();

  // ------------------------------------------------------------------
  // 2. JWT (header.payload.sig)
  // ------------------------------------------------------------------
  if (isJwtShape(bearer)) {
    let claims;
    try {
      claims = await verifyEndUserJwt(controlDb, appId, bearer);
    } catch {
      if (authProvider) {
        const platformResult = await tryPlatformOwnerJwt(controlDb, appId, bearer, authProvider);
        if (platformResult) return platformResult;
      }
      return { error: 'auth_failed', status: 401, body: { error: 'invalid_jwt' } };
    }

    const creds = await svc.anonCredentialsFor(appId);
    if (!creds) {
      return { error: 'auth_failed', status: 404, body: { error: 'no_kv_credential' } };
    }

    return {
      appId: creds.app_id,
      region: creds.region,
      redisPassword: creds.redis_password,
      identity: {
        kind: 'jwt',
        userId: String(claims.sub ?? ''),
        role: (claims as { role?: string | null }).role ?? null,
      },
      allowExposeWrites: false,
    };
  }

  // ------------------------------------------------------------------
  // 3a. Function key (exact match, stored unhashed)
  // ------------------------------------------------------------------
  const fnCreds = await svc.resolveFunctionKey(bearer, appId);
  if (fnCreds) {
    return {
      appId: fnCreds.app_id,
      region: fnCreds.region,
      redisPassword: fnCreds.redis_password,
      identity: { kind: 'function' },
      allowExposeWrites: true,
    };
  }

  // ------------------------------------------------------------------
  // 3b. Dev API key (sha256-hashed, must own the app)
  // ------------------------------------------------------------------
  const apiKeyCreds = await svc.resolveDevApiKeyForApp(bearer, appId);
  if (apiKeyCreds && apiKeyCreds.redis_password) {
    return {
      appId: apiKeyCreds.app_id,
      region: apiKeyCreds.region,
      redisPassword: apiKeyCreds.redis_password,
      identity: { kind: 'apiKey' },
      allowExposeWrites: true,
    };
  }

  // ------------------------------------------------------------------
  // 4. Nothing matched
  // ------------------------------------------------------------------
  return { error: 'auth_failed', status: 403, body: { error: 'forbidden' } };
}

// ---------------------------------------------------------------------------
// Platform-owner JWT helper
// ---------------------------------------------------------------------------

/**
 * Tries to authenticate a bearer token as a platform-user (Cognito or local-auth)
 * JWT that owns the requested app.  Returns a KvAuthSuccess with apiKey identity
 * if all three checks pass:
 *   1. authProvider.verifyJwt succeeds
 *   2. platform_users.cognito_sub matches the JWT's sub
 *   3. apps.owner_id = platform_users.id for the requested appId
 * Returns null on any failure (caller should fall through to 401).
 */
async function tryPlatformOwnerJwt(
  controlDb: Pool,
  appId: string,
  bearer: string,
  authProvider: AuthProvider,
): Promise<KvAuthSuccess | null> {
  let claims: { sub: string };
  try {
    claims = await authProvider.verifyJwt(bearer);
  } catch {
    return null;
  }
  const r = await controlDb.query<{ region: string; redis_password: string }>(
    `SELECT akc.region, akc.redis_password
       FROM platform_users pu
       JOIN apps a ON a.owner_id = pu.id AND a.id = $2
       JOIN app_kv_credentials akc ON akc.app_id = a.id
      WHERE pu.cognito_sub = $1
      LIMIT 1`,
    [claims.sub, appId],
  );
  if (r.rows.length === 0) return null;
  return {
    appId,
    region: r.rows[0].region,
    redisPassword: r.rows[0].redis_password,
    identity: { kind: 'apiKey' },
    allowExposeWrites: true,
  };
}
