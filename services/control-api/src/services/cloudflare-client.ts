// cloudflare-client.ts
import { config } from '../config.js';

export const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${config.cloudflare.accountId}`;

export interface CfResult<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

/**
 * Shared fetch wrapper for the Cloudflare v4 API.
 *
 * Assumes endpoints return the standard `{ success, errors, result }` envelope
 * and unwraps `result` on success. For endpoints that return raw bodies (rare),
 * use `fetch` directly.
 *
 * Behaviour:
 * - Injects the Bearer token from `config.cloudflare.apiToken`.
 * - Sets `Content-Type: application/json` automatically, EXCEPT when `init.body`
 *   is a FormData instance (so the runtime can set the multipart boundary).
 * - Throws on `success: false` with a message including HTTP status, path,
 *   and all `code`/`message` pairs from the CF error array.
 */
export async function cfFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${CF_BASE}${path}`;
  const headers: HeadersInit = {
    Authorization: `Bearer ${config.cloudflare.apiToken}`,
    ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers ?? {}),
  };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: CfResult<T>;
  try {
    body = JSON.parse(text) as CfResult<T>;
  } catch {
    throw new Error(`CF API error (${res.status}) ${path}: non-JSON response: ${text.slice(0, 300)}`);
  }
  if (!body.success) {
    const msg = body.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ') ?? res.statusText;
    throw new Error(`CF API error (${res.status}) ${path}: ${msg}`);
  }
  return body.result;
}
