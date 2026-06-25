import crypto from 'node:crypto';
import type { Pool } from 'pg';

export interface RegisterRequest {
  client_name?: string;
  redirect_uris: string[];
}

export interface OAuthClient {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  created_at: Date;
}

const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LEN = 2048;
const MAX_CLIENT_NAME_LEN = 200;

function validate(req: RegisterRequest): void {
  if (!Array.isArray(req.redirect_uris) || req.redirect_uris.length < 1) {
    throw new Error('redirect_uris must contain at least 1 entry');
  }
  if (req.redirect_uris.length > MAX_REDIRECT_URIS) {
    throw new Error(`redirect_uris must contain at most ${MAX_REDIRECT_URIS} entries`);
  }
  for (const uri of req.redirect_uris) {
    if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_REDIRECT_URI_LEN) {
      throw new Error('redirect_uri must be a non-empty string ≤2048 chars');
    }
    let parsed: URL;
    try { parsed = new URL(uri); } catch { throw new Error(`invalid redirect_uri: ${uri}`); }
    if (parsed.hash) throw new Error('redirect_uri must not contain a fragment');
    if (parsed.protocol === 'https:') continue;
    if (parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) continue;
    throw new Error(`redirect_uri must use https or loopback http (127.0.0.1 / localhost): ${uri}`);
  }
  if (req.client_name !== undefined && (typeof req.client_name !== 'string' || req.client_name.length > MAX_CLIENT_NAME_LEN)) {
    throw new Error(`client_name must be a string ≤${MAX_CLIENT_NAME_LEN} chars`);
  }
}

export class OAuthClientService {
  static async register(pool: Pool, req: RegisterRequest): Promise<OAuthClient> {
    validate(req);
    const client_id = `mcp_${crypto.randomBytes(12).toString('hex')}`;
    const result = await pool.query<{ client_id: string; client_name: string | null; redirect_uris: string[]; created_at: Date }>(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
       VALUES ($1, $2, $3)
       RETURNING client_id, client_name, redirect_uris, created_at`,
      [client_id, req.client_name ?? null, req.redirect_uris]
    );
    return result.rows[0];
  }

  static async lookup(pool: Pool, client_id: string): Promise<OAuthClient | null> {
    const r = await pool.query<OAuthClient>(
      `SELECT client_id, client_name, redirect_uris, created_at FROM oauth_clients WHERE client_id = $1`,
      [client_id]
    );
    return r.rows[0] ?? null;
  }

  static async touch(pool: Pool, client_id: string): Promise<void> {
    await pool.query(`UPDATE oauth_clients SET last_used_at = now() WHERE client_id = $1`, [client_id]);
  }
}
