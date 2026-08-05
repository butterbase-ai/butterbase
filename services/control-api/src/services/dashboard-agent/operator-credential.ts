import crypto from 'node:crypto';
import pg from 'pg';

const ALGORITHM = 'aes-256-gcm';

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
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
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
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(row.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
