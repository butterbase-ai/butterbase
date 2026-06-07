import { describe, it, expect, beforeAll } from 'vitest';
import {
  mintEndUserStreamToken,
  verifyEndUserStreamToken,
} from '../services/agent-stream-tokens.js';
import crypto from 'node:crypto';

const APP_ID = '00000000-0000-0000-0000-0000000000aa';
const RUN_ID = '00000000-0000-0000-0000-0000000000bb';
let signingKey: crypto.KeyObject;

beforeAll(() => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  signingKey = privateKey;
});

describe('agent stream tokens', () => {
  it('mints a token verifiable with the same key', async () => {
    const tok = await mintEndUserStreamToken(signingKey, APP_ID, RUN_ID, 'user-1', 60);
    const claims = await verifyEndUserStreamToken(signingKey, APP_ID, RUN_ID, tok);
    expect(claims.caller_user_id).toBe('user-1');
    expect(claims.aud).toBe('agent-stream');
    expect(claims.sub).toBe(RUN_ID);
  });

  it('rejects token for a different run', async () => {
    const tok = await mintEndUserStreamToken(signingKey, APP_ID, RUN_ID, null, 60);
    await expect(
      verifyEndUserStreamToken(signingKey, APP_ID, 'other-run', tok),
    ).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const tok = await mintEndUserStreamToken(signingKey, APP_ID, RUN_ID, null, -10);
    await expect(
      verifyEndUserStreamToken(signingKey, APP_ID, RUN_ID, tok),
    ).rejects.toThrow();
  });

  it('rejects a tampered signature', async () => {
    const tok = await mintEndUserStreamToken(signingKey, APP_ID, RUN_ID, null, 60);
    const bad = tok.slice(0, -2) + (tok.endsWith('aa') ? 'bb' : 'aa');
    await expect(
      verifyEndUserStreamToken(signingKey, APP_ID, RUN_ID, bad),
    ).rejects.toThrow();
  });
});
