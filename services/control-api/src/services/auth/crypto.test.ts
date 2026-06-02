import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { encrypt, decrypt } from './crypto.js';

const KEY = crypto.randomBytes(32).toString('hex');

describe('AES-256-GCM encrypt/decrypt (auth/)', () => {
  it('round-trips plaintext', () => {
    const plaintext = 'signing-key-pem-blob';
    expect(decrypt(encrypt(plaintext, KEY), KEY)).toBe(plaintext);
  });

  it('rejects a truncated GCM auth tag (CVE-class: tag-length forgery)', () => {
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
    const ct = encrypt('top-secret', KEY);
    const [iv, body, tag] = ct.split(':');
    const tampered = Buffer.from(body, 'base64');
    tampered[0] ^= 0x01;
    expect(() =>
      decrypt(`${iv}:${tampered.toString('base64')}:${tag}`, KEY)
    ).toThrow();
  });
});
