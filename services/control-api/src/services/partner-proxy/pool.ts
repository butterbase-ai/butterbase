import type { Pool as PgPool } from 'pg';
import { decrypt } from '../crypto.js';
import type { AuthTemplate } from './auth-template.js';

export interface PartnerPool {
  id: string;
  hackathon_id: string;
  slug: string;
  display_name: string;
  base_url: string;
  auth_template: AuthTemplate;
  contact_message: string;
  docs_url: string | null;
  description: string | null;
}

export interface PickedKey {
  id: string;
  plaintext: string;
}

const FAILURE_BODY_MAX = 1024;

export async function loadPool(db: PgPool, hackathonId: string, slug: string): Promise<PartnerPool | null> {
  const { rows } = await db.query(
    `SELECT id, hackathon_id, slug, display_name, base_url, auth_template,
            contact_message, docs_url, description
     FROM partner_pools WHERE hackathon_id = $1 AND slug = $2`,
    [hackathonId, slug]
  );
  return rows.length ? (rows[0] as PartnerPool) : null;
}

const PICK_KEY_MAX_ATTEMPTS = 10;

export async function pickNextKey(db: PgPool, poolId: string, excludeIds: string[]): Promise<PickedKey | null> {
  const encryptionKey = process.env.AUTH_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error('AUTH_ENCRYPTION_KEY not set');

  // Bounded loop: if the active row at the head of the queue has a corrupt
  // encrypted_key, mark it 'revoked' and try the next one — but cap at
  // PICK_KEY_MAX_ATTEMPTS so a pool full of corrupt rows can't pin a request.
  const excluded = [...excludeIds];
  for (let attempt = 0; attempt < PICK_KEY_MAX_ATTEMPTS; attempt++) {
    const { rows } = await db.query(
      `SELECT id, encrypted_key FROM partner_keys
       WHERE pool_id = $1 AND status = 'active' AND NOT (id = ANY($2::uuid[]))
       ORDER BY last_used_at NULLS FIRST, id
       LIMIT 1`,
      [poolId, excluded]
    );
    if (!rows.length) return null;

    let plaintext: string;
    try {
      plaintext = decrypt(rows[0].encrypted_key, encryptionKey);
    } catch (err) {
      // Corrupt key — revoke it so we don't pick it again.
      await db.query(`UPDATE partner_keys SET status = 'revoked' WHERE id = $1`, [rows[0].id]);
      excluded.push(rows[0].id);
      continue;
    }

    return { id: rows[0].id, plaintext };
  }

  // Hit the corruption cap — treat as no-active-keys.
  return null;
}

export async function markKeyUsed(db: PgPool, keyId: string): Promise<void> {
  await db.query(
    `UPDATE partner_keys SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1`,
    [keyId]
  );
}

export async function markKeyExhausted(
  db: PgPool, keyId: string, statusCode: number, body: string,
): Promise<void> {
  const truncated = body.length > FAILURE_BODY_MAX ? body.slice(0, FAILURE_BODY_MAX) : body;
  await db.query(
    `UPDATE partner_keys
     SET status = 'exhausted',
         last_failed_at = now(),
         last_failure_status = $2,
         last_failure_body = $3,
         failure_count = failure_count + 1
     WHERE id = $1`,
    [keyId, statusCode, truncated]
  );
}

export async function countActiveKeys(db: PgPool, poolId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM partner_keys WHERE pool_id = $1 AND status = 'active'`,
    [poolId]
  );
  return rows[0].n;
}
