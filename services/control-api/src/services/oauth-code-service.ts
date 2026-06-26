import crypto from 'node:crypto';
import type { Pool } from 'pg';

const TTL_MS = 60_000;
const CODE_BYTES = 32;

export interface RequestedTarget {
  key_scope: 'account' | 'app';
  target_app_id?: string;
  additional_scopes: string[];
}

export interface IssueParams {
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  requested_target: RequestedTarget;
}

export interface ConsumeParams {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_verifier: string;
}

export interface ConsumeOk {
  user_id: string;
  scope: string;
  requested_target: RequestedTarget;
}

export type ConsumeResult = ConsumeOk | { error: 'invalid_grant' };

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  // timingSafeEqual requires equal-length buffers
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class OAuthCodeService {
  static async issue(pool: Pool, p: IssueParams): Promise<{ code: string; expires_at: Date }> {
    const code = crypto.randomBytes(CODE_BYTES).toString('base64url');
    const code_hash = hashCode(code);
    const expires_at = new Date(Date.now() + TTL_MS);
    await pool.query(
      `INSERT INTO oauth_authorization_codes
         (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, requested_target, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'S256', $7, $8)`,
      [code_hash, p.client_id, p.user_id, p.redirect_uri, p.scope, p.code_challenge, p.requested_target, expires_at]
    );
    return { code, expires_at };
  }

  static async consume(pool: Pool, p: ConsumeParams): Promise<ConsumeResult> {
    const code_hash = hashCode(p.code);
    // Atomically claim the code. The WHERE clause enforces single-use, not-expired,
    // matching client+redirect_uri. NULL on no-match → invalid_grant.
    const r = await pool.query<{ user_id: string; scope: string; code_challenge: string; requested_target: RequestedTarget }>(
      `UPDATE oauth_authorization_codes
       SET consumed_at = now()
       WHERE code_hash = $1
         AND client_id = $2
         AND redirect_uri = $3
         AND consumed_at IS NULL
         AND expires_at > now()
       RETURNING user_id, scope, code_challenge, requested_target`,
      [code_hash, p.client_id, p.redirect_uri]
    );
    if (r.rows.length === 0) return { error: 'invalid_grant' };
    const row = r.rows[0];
    if (!verifyPkce(p.code_verifier, row.code_challenge)) return { error: 'invalid_grant' };
    return { user_id: row.user_id, scope: row.scope, requested_target: row.requested_target };
  }
}
