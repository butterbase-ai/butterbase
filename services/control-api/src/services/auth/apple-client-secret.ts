import { SignJWT, importPKCS8 } from 'jose';

/**
 * Generates Apple's JWT client_secret from team/key/private key credentials.
 * Apple requires a dynamically generated client_secret signed with ES256.
 */
export async function generateAppleClientSecret(
  clientId: string,
  teamId: string,
  keyId: string,
  privateKeyPem: string
): Promise<string> {
  const key = await importPKCS8(privateKeyPem, 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId)
    .setSubject(clientId)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt()
    .setExpirationTime('180d')
    .sign(key);
}
