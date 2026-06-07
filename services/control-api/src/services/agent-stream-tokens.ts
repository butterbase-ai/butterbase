import * as jose from 'jose';
import crypto from 'node:crypto';

export interface StreamTokenClaims {
  aud: string;
  iss: string;
  sub: string;
  caller_user_id: string | null;
  exp: number;
}

/** Mint a short-lived stream token signed with the app's existing private key. */
export async function mintEndUserStreamToken(
  privateKey: crypto.KeyObject,
  appId: string,
  runId: string,
  callerUserId: string | null,
  expiresInSeconds: number,
): Promise<string> {
  const alg = 'RS256';
  return new jose.SignJWT({ caller_user_id: callerUserId })
    .setProtectedHeader({ alg })
    .setIssuer(appId)
    .setSubject(runId)
    .setAudience('agent-stream')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(privateKey);
}

/** Verify a stream token. Throws if signature, audience, issuer, sub, or expiry are wrong. */
export async function verifyEndUserStreamToken(
  publicOrPrivateKey: crypto.KeyObject,
  appId: string,
  runId: string,
  token: string,
): Promise<StreamTokenClaims> {
  const key = publicOrPrivateKey.type === 'private'
    ? crypto.createPublicKey(publicOrPrivateKey)
    : publicOrPrivateKey;
  const { payload } = await jose.jwtVerify(token, key, {
    audience: 'agent-stream',
    issuer: appId,
  });
  if (payload.sub !== runId) {
    throw new Error('stream token sub mismatch');
  }
  return {
    aud: 'agent-stream',
    iss: appId,
    sub: payload.sub!,
    caller_user_id: (payload.caller_user_id as string | null | undefined) ?? null,
    exp: payload.exp!,
  };
}
