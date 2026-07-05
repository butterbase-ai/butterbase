// Encryption utilities for encrypting and decrypting environment variables
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";

// Pin the GCM authentication tag to 16 bytes. Without an explicit length,
// node:crypto will accept any tag from 4 to 16 bytes on decrypt, which lets
// a forged ciphertext-with-truncated-tag pass auth at 2^32 work instead of
// 2^128 (CWE-310 / OWASP-A02:2021).
const GCM_AUTH_TAG_BYTES = 16;

/**
 * Encrypt plaintext using AES-256-GCM
 * Format: base64(iv):base64(ciphertext):base64(authTag)
 */
export function encrypt(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  });

  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  const authTag = cipher.getAuthTag().toString("base64");

  return `${iv.toString("base64")}:${encrypted}:${authTag}`;
}

/**
 * Decrypt AES-256-GCM encrypted data
 * Format: base64(iv):base64(ciphertext):base64(authTag)
 */
export function decrypt(encrypted: string, key: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format");
  }

  const [ivBase64, ciphertextBase64, authTagBase64] = parts;

  // Decode from base64
  const iv = Buffer.from(ivBase64, "base64");
  const ciphertext = Buffer.from(ciphertextBase64, "base64");
  const authTag = Buffer.from(authTagBase64, "base64");

  if (authTag.length !== GCM_AUTH_TAG_BYTES) {
    throw new Error(
      `Invalid GCM auth tag length: expected ${GCM_AUTH_TAG_BYTES} bytes, got ${authTag.length}`,
    );
  }

  // Convert hex key to buffer
  const keyBuffer = Buffer.from(key, "hex");

  // Create decipher
  const decipher = createDecipheriv("aes-256-gcm", keyBuffer, iv, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(authTag);

  // Decrypt
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString("utf8");
}

/**
 * Decrypt environment variables stored as encrypted JSON
 */
export function decryptEnvVars(
  encrypted: string | null,
  key: string
): Record<string, string> {
  if (!encrypted) {
    return {};
  }

  try {
    const decrypted = decrypt(encrypted, key);
    return JSON.parse(decrypted);
  } catch (error) {
    console.error("Failed to decrypt env vars:", error);
    return {};
  }
}
