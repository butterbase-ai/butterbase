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
 * Expects a string in the format `iv:ciphertext:authTag`.
 */
export function decryptByok(encrypted: string): string {
  return decrypt(encrypted, getKey());
}
