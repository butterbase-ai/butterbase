import crypto from 'node:crypto';
import type { Pool } from 'pg';
import * as jose from 'jose';
import { nanoid } from 'nanoid';
import { encrypt, decrypt } from './crypto.js';
import { config } from '../../config.js';
import { getRuntimeDbForApp } from '../region-resolver.js';
import { onKeyInvalidated } from '../key-invalidation.js';

interface SigningKeyPair {
  kid: string;
  privateKey: crypto.KeyObject;
  publicKey: string;
}

// In-memory cache for decrypted private keys (max 100 entries, LRU)
const keyCache = new Map<string, { key: SigningKeyPair; lastUsed: number }>();
const MAX_CACHE_SIZE = 100;

onKeyInvalidated((appId) => {
  keyCache.delete(appId);
});

/**
 * Evicts the least recently used key from cache
 */
function evictLRU() {
  if (keyCache.size < MAX_CACHE_SIZE) return;

  let oldestKey: string | null = null;
  let oldestTime = Date.now();

  for (const [key, value] of keyCache.entries()) {
    if (value.lastUsed < oldestTime) {
      oldestTime = value.lastUsed;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    keyCache.delete(oldestKey);
  }
}

/**
 * Generates a new RSA-2048 key pair
 */
function generateKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  return { privateKey, publicKey };
}

/**
 * Gets or creates a signing key for an app (lazy initialization)
 */
export async function getOrCreateSigningKey(
  controlPool: Pool,
  appId: string
): Promise<SigningKeyPair> {
  // Check cache first
  const cached = keyCache.get(appId);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.key;
  }

  const runtimePool = await getRuntimeDbForApp(controlPool, appId);

  // Check database
  const result = await runtimePool.query(
    `SELECT kid, private_key_encrypted, public_key
     FROM app_signing_keys
     WHERE app_id = $1 AND active = true
     LIMIT 1`,
    [appId]
  );

  let kid: string;
  let privateKeyPem: string;
  let publicKeyPem: string;

  if (result.rows.length > 0) {
    // Decrypt existing key
    const row = result.rows[0];
    kid = row.kid;
    privateKeyPem = decrypt(row.private_key_encrypted, config.auth.encryptionKey);
    publicKeyPem = row.public_key;
  } else {
    // Generate new key pair
    const keyPair = generateKeyPair();
    kid = nanoid(16);

    // Encrypt private key before storage
    const encryptedPrivateKey = encrypt(keyPair.privateKey, config.auth.encryptionKey);

    await runtimePool.query(
      `INSERT INTO app_signing_keys (app_id, kid, private_key_encrypted, public_key)
       VALUES ($1, $2, $3, $4)`,
      [appId, kid, encryptedPrivateKey, keyPair.publicKey]
    );

    privateKeyPem = keyPair.privateKey;
    publicKeyPem = keyPair.publicKey;
  }

  // Import private key
  const privateKey = crypto.createPrivateKey(privateKeyPem);

  const keyPair: SigningKeyPair = {
    kid,
    privateKey,
    publicKey: publicKeyPem,
  };

  // Cache it
  evictLRU();
  keyCache.set(appId, { key: keyPair, lastUsed: Date.now() });

  return keyPair;
}

/**
 * Gets public keys for JWKS endpoint
 */
export async function getPublicKeysForJwks(
  controlPool: Pool,
  appId: string
): Promise<jose.JWK[]> {
  const runtimePool = await getRuntimeDbForApp(controlPool, appId);
  const result = await runtimePool.query(
    `SELECT kid, public_key, algorithm
     FROM app_signing_keys
     WHERE app_id = $1 AND active = true`,
    [appId]
  );

  const jwks: jose.JWK[] = [];

  for (const row of result.rows) {
    const publicKey = crypto.createPublicKey(row.public_key);
    const jwk = await jose.exportJWK(publicKey);
    jwk.kid = row.kid;
    jwk.alg = row.algorithm;
    jwk.use = 'sig';
    jwks.push(jwk);
  }

  return jwks;
}
