// Encryption utilities for decrypting environment variables
import { createDecipheriv } from "node:crypto";

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

  // Convert hex key to buffer
  const keyBuffer = Buffer.from(key, "hex");

  // Create decipher
  const decipher = createDecipheriv("aes-256-gcm", keyBuffer, iv);
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
