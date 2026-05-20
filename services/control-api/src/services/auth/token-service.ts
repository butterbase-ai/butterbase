import crypto from 'node:crypto';
import type { Pool } from 'pg';
import * as jose from 'jose';
import { nanoid } from 'nanoid';
import {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_DAYS,
  JWT_ISSUER_PREFIX,
} from '@butterbase/shared/constants';
import type { EndUserClaims } from '@butterbase/shared/types';
import { getRuntimeDbForApp } from '../region-resolver.js';

/**
 * Signs an access token (JWT) using RS256
 */
export async function signAccessToken(
  privateKey: crypto.KeyObject,
  kid: string,
  claims: {
    sub: string;
    email: string;
    app_id: string;
    email_verified: boolean;
  },
  ttl?: string // Optional custom TTL, defaults to ACCESS_TOKEN_TTL
): Promise<string> {
  const jwt = await new jose.SignJWT({
    sub: claims.sub,
    email: claims.email,
    email_verified: claims.email_verified,
    app_id: claims.app_id,
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt()
    .setIssuer(`${JWT_ISSUER_PREFIX}${claims.app_id}`)
    .setExpirationTime(ttl || ACCESS_TOKEN_TTL)
    .sign(privateKey);

  return jwt;
}

/**
 * Creates a refresh token and stores it in the app's home-region runtime DB.
 */
export async function createRefreshToken(
  controlPool: Pool,
  appId: string,
  userId: string,
  ttlDays?: number // Optional custom TTL in days, defaults to REFRESH_TOKEN_TTL_DAYS
): Promise<string> {
  const token = nanoid(32);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + (ttlDays || REFRESH_TOKEN_TTL_DAYS));

  const runtimePool = await getRuntimeDbForApp(controlPool, appId);

  await runtimePool.query(
    `INSERT INTO app_refresh_tokens (app_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [appId, userId, tokenHash, expiresAt]
  );

  return token;
}

/**
 * Consumes a refresh token (validates, revokes, and returns user info).
 * Implements token rotation — old token is revoked.
 *
 * Takes the appId explicitly because refresh tokens are stored in the app's
 * home-region runtime DB, and the token hash alone doesn't tell us where to
 * look. Callers receive appId from the URL params on /auth/:app_id/refresh.
 */
export async function consumeRefreshToken(
  controlPool: Pool,
  appId: string,
  rawToken: string
): Promise<{ appId: string; userId: string; email: string } | null> {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const runtimePool = await getRuntimeDbForApp(controlPool, appId);

  // Scope by app_id so a token from a different app can't be consumed here,
  // and so the lookup hits the right region's tables.
  const result = await runtimePool.query(
    `SELECT rt.app_id, rt.user_id, rt.expires_at, rt.revoked_at, u.email
     FROM app_refresh_tokens rt
     JOIN app_users u ON rt.user_id = u.id
     WHERE rt.token_hash = $1 AND rt.app_id = $2`,
    [tokenHash, appId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  // Check if revoked
  if (row.revoked_at) {
    return null;
  }

  // Check if expired
  if (new Date(row.expires_at) < new Date()) {
    return null;
  }

  // Revoke the token (token rotation)
  await runtimePool.query(
    `UPDATE app_refresh_tokens
     SET revoked_at = now()
     WHERE token_hash = $1 AND app_id = $2`,
    [tokenHash, appId]
  );

  return {
    appId: row.app_id,
    userId: row.user_id,
    email: row.email,
  };
}

/**
 * Revokes all refresh tokens for a user (used for logout / password reset).
 */
export async function revokeAllRefreshTokens(
  controlPool: Pool,
  appId: string,
  userId: string
): Promise<void> {
  const runtimePool = await getRuntimeDbForApp(controlPool, appId);
  await runtimePool.query(
    `UPDATE app_refresh_tokens
     SET revoked_at = now()
     WHERE app_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [appId, userId]
  );
}

/**
 * Verifies an access token and returns claims
 */
export async function verifyAccessToken(
  publicKey: crypto.KeyObject,
  token: string,
  appId: string
): Promise<EndUserClaims> {
  const { payload } = await jose.jwtVerify(token, publicKey, {
    issuer: `${JWT_ISSUER_PREFIX}${appId}`,
    algorithms: ['RS256'],
  });

  return payload as unknown as EndUserClaims;
}
