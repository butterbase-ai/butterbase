import * as jose from 'jose';
import type { Pool } from 'pg';
import crypto from 'node:crypto';
import type { EndUserClaims } from '@butterbase/shared/types';
import { JWT_ISSUER_PREFIX } from '@butterbase/shared/constants';
import { onKeyInvalidated } from './key-invalidation.js';
import { getRuntimeDbForApp } from './region-resolver.js';

interface CachedKey {
  key: crypto.KeyObject;
  expires: number;
}

export class EndUserSigningKeyNotFoundError extends Error {
  constructor(appId: string) {
    super(`No active signing key found for app ${appId}`);
    this.name = 'EndUserSigningKeyNotFoundError';
  }
}

const publicKeyCache = new Map<string, CachedKey>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

onKeyInvalidated((appId) => {
  publicKeyCache.delete(appId);
});

/**
 * Verifies an end-user JWT and returns claims
 */
export async function verifyEndUserJwt(
  controlDb: Pool,
  appId: string,
  token: string
): Promise<EndUserClaims> {
  // Check cache first
  let cached = publicKeyCache.get(appId);

  if (!cached || cached.expires < Date.now()) {
    // Fetch public key from the app's home region (cross-region safe).
    const runtimePool = await getRuntimeDbForApp(controlDb, appId);
    const result = await runtimePool.query(
      `SELECT public_key FROM app_signing_keys WHERE app_id = $1 AND active = true LIMIT 1`,
      [appId]
    );

    if (result.rows.length === 0) {
      throw new EndUserSigningKeyNotFoundError(appId);
    }

    const publicKey = crypto.createPublicKey(result.rows[0].public_key);

    cached = {
      key: publicKey,
      expires: Date.now() + CACHE_TTL,
    };

    publicKeyCache.set(appId, cached);
  }

  // Verify JWT
  const { payload } = await jose.jwtVerify(token, cached.key, {
    issuer: `${JWT_ISSUER_PREFIX}${appId}`,
    algorithms: ['RS256'],
  });

  return payload as unknown as EndUserClaims;
}
