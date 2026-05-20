import type { Pool as PgPool } from 'pg';
import { renderAuthTemplate } from './auth-template.js';
import { assertPublicHttpsUrl } from './url-guard.js';
import {
  pickNextKey, markKeyUsed, markKeyExhausted, type PartnerPool,
} from './pool.js';

export interface ForwardInput {
  method: string;
  pathAndQuery: string; // begins with '/', may include '?...'
  headers: Record<string, string | string[] | undefined>;
  /** Buffer (small body) or ReadableStream (streamed) or undefined for GET/HEAD. */
  body?: Buffer | ReadableStream<Uint8Array>;
}

export type ForwardResult =
  | { kind: 'ok'; response: Response; keyId: string; attempts: number }
  | { kind: 'exhausted'; attempts: number };

const MAX_ATTEMPTS = 3;
const QUOTA_DEAD = new Set([401, 402, 403, 429]);

const HEADER_BLOCKLIST = new Set([
  'host', 'authorization', 'cookie', 'content-length',
  'connection', 'transfer-encoding', 'expect', 'upgrade',
]);

export async function forwardRequest(
  db: PgPool, pool: PartnerPool, input: ForwardInput,
): Promise<ForwardResult> {
  const tried: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const picked = await pickNextKey(db, pool.id, tried);
    if (!picked) {
      return { kind: 'exhausted', attempts: tried.length };
    }
    tried.push(picked.id);

    // Build outbound URL + headers per attempt (auth differs per key).
    const auth = renderAuthTemplate(pool.auth_template, picked.plaintext);
    let url = pool.base_url.replace(/\/$/, '') + input.pathAndQuery;
    const outboundHeaders = new Headers();
    for (const [k, v] of Object.entries(input.headers)) {
      if (v == null) continue;
      if (HEADER_BLOCKLIST.has(k.toLowerCase())) continue;
      outboundHeaders.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    if (auth.kind === 'header') outboundHeaders.set(auth.name, auth.value);
    if (auth.kind === 'query') {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}${encodeURIComponent(auth.name)}=${encodeURIComponent(auth.value)}`;
    }

    const init: RequestInit & { duplex?: 'half' } = {
      method: input.method,
      headers: outboundHeaders,
    };
    if (input.body !== undefined && input.method !== 'GET' && input.method !== 'HEAD') {
      init.body = input.body as any;
      if (input.body instanceof ReadableStream) init.duplex = 'half';
    }

    // Defense-in-depth: re-validate base_url host right before fetch, in case the
    // DB row was hand-edited to bypass the admin-route validation.
    try {
      assertPublicHttpsUrl(pool.base_url);
    } catch {
      return { kind: 'exhausted', attempts: attempt };
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Network failure on this key — mark it failed (status 0) and try the next one.
      // We continue rather than bail so transient DNS/connect issues on a single
      // upstream variant fall over to remaining keys; only true exhaustion ends the loop.
      await markKeyExhausted(db, picked.id, 0, (err as Error).message?.slice(0, 1024) ?? '');
      continue;
    }

    if (QUOTA_DEAD.has(res.status)) {
      const body = await res.text().catch(() => '');
      await markKeyExhausted(db, picked.id, res.status, body);
      continue;
    }

    await markKeyUsed(db, picked.id);
    return { kind: 'ok', response: res, keyId: picked.id, attempts: attempt };
  }

  return { kind: 'exhausted', attempts: MAX_ATTEMPTS };
}
