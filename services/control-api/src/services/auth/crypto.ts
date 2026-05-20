import crypto from 'node:crypto';

/**
 * Encrypts plaintext using AES-256-GCM
 * @param plaintext - The text to encrypt
 * @param keyHex - 64 hex character string (32 bytes)
 * @returns Base64 encoded string in format: iv:ciphertext:authTag
 */
export function encrypt(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');

  return `${iv.toString('base64')}:${encrypted}:${authTag}`;
}

/**
 * Decrypts ciphertext using AES-256-GCM
 * @param encrypted - Base64 encoded string in format: iv:ciphertext:authTag
 * @param keyHex - 64 hex character string (32 bytes)
 * @returns Decrypted plaintext
 */
export function decrypt(encrypted: string, keyHex: string): string {
  const [ivB64, ciphertextB64, authTagB64] = encrypted.split(':');
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertextB64, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
