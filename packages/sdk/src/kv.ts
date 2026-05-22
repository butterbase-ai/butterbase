// packages/sdk/src/kv.ts
import {
  KvError, KvNotFoundError, KvKeyInvalidError, KvAuthError, KvForbiddenError, KvConnectionError,
} from './errors/kv.js';

export interface KvShim {
  get<T = unknown>(key: string, opts?: { touch?: boolean }): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<number>;
}

export interface MakeKvOptions {
  appId: string;
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
}

export function makeKv(opts: MakeKvOptions): KvShim {
  const f = opts.fetch ?? fetch;
  const root = `${opts.baseUrl}/v1/${opts.appId}/kv`;
  const headers = {
    authorization: `Bearer ${opts.apiKey}`,
    'content-type': 'application/json',
  };

  async function call(method: string, key: string, body?: unknown): Promise<Response> {
    return f(`${root}/${key}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function throwForStatus(res: Response, body: { error?: string; message?: string } | null): never {
    const msg = body?.message ?? `kv error (status ${res.status})`;
    if (res.status === 400) throw new KvKeyInvalidError(msg);
    if (res.status === 401) throw new KvAuthError(msg);
    if (res.status === 403) throw new KvForbiddenError(msg);
    if (res.status === 503) throw new KvConnectionError(msg);
    throw new KvError(msg, body?.error ?? 'KV_ERROR', res.status);
  }

  return {
    async get<T>(key: string, opts?: { touch?: boolean }): Promise<T | null> {
      const path = opts?.touch === true ? `${key}?touch=true` : key;
      const res = await call('GET', path);
      if (res.status === 404) return null;
      if (!res.ok) throwForStatus(res, await res.json().catch(() => null));
      return (await res.json() as { value: T }).value;
    },

    async set(key: string, value: unknown): Promise<void> {
      const res = await call('PUT', key, { value });
      if (!res.ok && res.status !== 204) throwForStatus(res, await res.json().catch(() => null));
    },

    async del(key: string): Promise<number> {
      const res = await call('DELETE', key);
      if (res.status === 204) return 1;
      if (res.status === 404) return 0;
      throwForStatus(res, await res.json().catch(() => null));
    },
  };
}
