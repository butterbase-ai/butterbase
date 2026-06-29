// Thin wrappers over the AES-256-GCM helper used by ai-config.ts.
// Callers store/retrieve the returned string as a VARCHAR column.
// Matches the synchronous API of the underlying encrypt/decrypt primitives.
import { encrypt, decrypt } from '../crypto.js';
import { config } from '../../config.js';

function getKey(): string {
  const key = config.auth.encryptionKey;
  if (!key) throw new Error('AUTH_ENCRYPTION_KEY not set — cannot encrypt/decrypt BYOK key');
  return key;
}

/**
 * Encrypts a BYOK API key using AES-256-GCM.
 * Returns a string in the format `iv:ciphertext:authTag` (base64-encoded parts).
 */
export function encryptByok(plain: string): string {
  return encrypt(plain, getKey());
}

/**
 * Decrypts a BYOK API key previously encrypted with encryptByok().
 * Accepts either the original string OR a Buffer: the `bytea` column in
 * `apps.people_byok_key_encrypted` round-trips the stored UTF-8 bytes
 * as a Buffer on SELECT, so passing the column value directly would
 * otherwise hit `.split is not a function` and the route would 503.
 */
export function decryptByok(encrypted: string | Buffer): string {
  const s = typeof encrypted === 'string' ? encrypted : encrypted.toString('utf8');
  return decrypt(s, getKey());
}
