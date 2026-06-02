import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { encrypt, decrypt } from './crypto.js';

const KEY = crypto.randomBytes(32).toString('hex');

describe('AES-256-GCM encrypt/decrypt', () => {
  it('round-trips plaintext', () => {
    const plaintext = 'oauth-client-secret-value-123';
    const ct = encrypt(plaintext, KEY);
    expect(decrypt(ct, KEY)).toBe(plaintext);
  });

  it('round-trips unicode and binary-ish payloads', () => {
    const plaintext = 'tokens=abc:def; emoji=🙂; nul=' + String.fromCharCode(0);
    expect(decrypt(encrypt(plaintext, KEY), KEY)).toBe(plaintext);
  });

  it('rejects a truncated GCM auth tag (CVE-class: tag-length forgery)', () => {
    // Pinned regression for the security fix: a forged ciphertext with a
    // short tag (e.g. 4 bytes) must not be accepted. Without the explicit
    // authTagLength + length check, node:crypto would let an attacker
    // brute-force a 32-bit tag at 2^32 work instead of 2^128.
    const ct = encrypt('top-secret', KEY);
    const [iv, body, tag] = ct.split(':');
    const truncated = Buffer.from(tag, 'base64').subarray(0, 4).toString('base64');
    expect(() => decrypt(`${iv}:${body}:${truncated}`, KEY)).toThrow(
      /Invalid GCM auth tag length/
    );
  });

  it('rejects an over-length GCM auth tag', () => {
    const ct = encrypt('top-secret', KEY);
    const [iv, body, tag] = ct.split(':');
    const oversized = Buffer.concat([
      Buffer.from(tag, 'base64'),
      Buffer.alloc(4, 0),
    ]).toString('base64');
    expect(() => decrypt(`${iv}:${body}:${oversized}`, KEY)).toThrow(
      /Invalid GCM auth tag length/
    );
  });

  it('rejects tampered ciphertext with a valid-length tag', () => {
    // Defense-in-depth: even when an attacker keeps the tag length correct,
    // GCM authentication must still reject a flipped ciphertext bit.
    const ct = encrypt('top-secret', KEY);
    const [iv, body, tag] = ct.split(':');
    const tampered = Buffer.from(body, 'base64');
    tampered[0] ^= 0x01;
    expect(() =>
      decrypt(`${iv}:${tampered.toString('base64')}:${tag}`, KEY)
    ).toThrow();
  });

  it('rejects ciphertext encrypted under a different key', () => {
    const ct = encrypt('top-secret', KEY);
    const otherKey = crypto.randomBytes(32).toString('hex');
    expect(() => decrypt(ct, otherKey)).toThrow();
  });
});
