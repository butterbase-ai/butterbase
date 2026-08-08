import crypto from 'node:crypto';
import pg from 'pg';

const ALGORITHM = 'aes-256-gcm';

/**
 * Full-length GCM tag. Pinned explicitly: Node otherwise accepts a short tag at
 * decrypt time and verifies against it, so a truncated stored auth_tag would
 * still decrypt while dropping forgery resistance from 2^128 to 2^(8*len).
 */
const AUTH_TAG_LENGTH = 16;

/**
 * The organization id is bound to the ciphertext as GCM additional authenticated
 * data, so a row copied into a different org's row fails authentication instead
 * of yielding the original org's service key.
 */
function aad(orgId: string): Buffer {
  return Buffer.from(orgId, 'utf8');
}

function key(): Buffer {
  const hex = process.env.OPERATOR_CRED_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('OPERATOR_CRED_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export async function setOperatorCredential(
  pool: pg.Pool,
  orgId: string,
  serviceKey: string,
): Promise<void> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(aad(orgId));
  const ciphertext = Buffer.concat([cipher.update(serviceKey, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  await pool.query(
    `INSERT INTO dashboard_agent_operator_credentials (organization_id, ciphertext, iv, auth_tag)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id) DO UPDATE
       SET ciphertext = EXCLUDED.ciphertext,
           iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag`,
    [orgId, ciphertext.toString('base64'), iv.toString('base64'), authTag.toString('base64')],
  );
}

export async function getOperatorCredential(
  pool: pg.Pool,
  orgId: string,
): Promise<string | null> {
  const r = await pool.query<{ ciphertext: string; iv: string; auth_tag: string }>(
    `SELECT ciphertext, iv, auth_tag FROM dashboard_agent_operator_credentials
     WHERE organization_id = $1`,
    [orgId],
  );
  if (r.rows.length === 0) return null;

  const row = r.rows[0];
  const authTag = Buffer.from(row.auth_tag, 'base64');
  if (authTag.length !== AUTH_TAG_LENGTH) {
    // Loud, like any other authentication failure: a stored tag of the wrong
    // length means the row was tampered with, never "this org has no credential".
    throw new Error('Stored operator credential has an invalid authentication tag');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(row.iv, 'base64'), {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAAD(aad(orgId));
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
