// packages/sdk/src/kv.ts
import {
  KvError, KvNotFoundError, KvKeyInvalidError, KvAuthError, KvForbiddenError, KvConnectionError,
  KvCasMismatchError, KvExposeConflictError, KvValueTooLargeError,
  KvRateLimitedError, KvCreditsExhaustedError, KvStorageFullError, KvKeysExhaustedError,
} from './errors/kv.js';

export type Role = 'public' | 'authed' | 'owner' | 'deny';

export interface KvShim {
  get<T = unknown>(key: string, opts?: { touch?: boolean }): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ttl?: number | null; ephemeral?: boolean }): Promise<void>;
  del(key: string): Promise<number>;

  incr(key: string, by?: number): Promise<number>;
  decr(key: string, by?: number): Promise<number>;
  setnx(key: string, value: unknown, opts?: { ttl?: number | null; ephemeral?: boolean }): Promise<boolean>;
  setex(key: string, value: unknown, ttl: number, opts?: { ephemeral?: boolean }): Promise<void>;
  cas(key: string, expected: unknown, next: unknown): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  ttl(key: string): Promise<number | null>;
  expire(key: string, ttl: number | null): Promise<boolean>;
  mget<T = unknown>(keys: string[]): Promise<(T | null)[]>;
  mset(entries: Record<string, unknown>, opts?: { ttl?: number | null }): Promise<void>;
  expose(pattern: string, opts: { read: Role; write: Role }): Promise<void>;
  unexpose(pattern: string): Promise<number>;
  listRules(): Promise<Array<{ pattern: string; read: Role; write: Role; order: number }>>;
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

  async function call(method: string, pathSuffix: string, body?: unknown): Promise<Response> {
    return f(`${root}/${pathSuffix}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function throwForStatus(
    res: Response,
    body: {
      error?: string;
      message?: string;
      retry_after?: number;
      used_bytes?: number;
      cap_bytes?: number;
      keys?: number;
      cap?: number;
    } | null,
  ): never {
    const msg = body?.message ?? `kv error (status ${res.status})`;
    if (res.status === 400) throw new KvKeyInvalidError(msg);
    if (res.status === 401) throw new KvAuthError(msg);
    if (res.status === 402) throw new KvCreditsExhaustedError(msg);
    if (res.status === 403) throw new KvForbiddenError(msg);
    if (res.status === 409) {
      if (body?.error === 'KV_EXPOSE_CONFLICT') throw new KvExposeConflictError(msg);
      throw new KvCasMismatchError(msg); // reserved for future strict-CAS mode
    }
    if (res.status === 413) throw new KvValueTooLargeError(msg);
    if (res.status === 429) throw new KvRateLimitedError(body?.retry_after ?? 0, msg);
    if (res.status === 503) throw new KvConnectionError(msg);
    if (res.status === 507) {
      if (body?.error === 'kv_storage_full') {
        throw new KvStorageFullError(body?.used_bytes ?? 0, body?.cap_bytes ?? 0, msg);
      }
      if (body?.error === 'kv_keys_exhausted') {
        throw new KvKeysExhaustedError(body?.keys ?? 0, body?.cap ?? 0, msg);
      }
      // Unknown 507 — fall through to generic KvError
    }
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

    async set(key: string, value: unknown, opts?: { ttl?: number | null; ephemeral?: boolean }): Promise<void> {
      const body: Record<string, unknown> = { value };
      if (opts?.ttl !== undefined) body.ttl = opts.ttl;
      if (opts?.ephemeral !== undefined) body.ephemeral = opts.ephemeral;
      const res = await call('PUT', key, body);
      if (!res.ok && res.status !== 204) throwForStatus(res, await res.json().catch(() => null));
    },

    async del(key: string): Promise<number> {
      const res = await call('DELETE', key);
      if (!res.ok) throwForStatus(res, await res.json().catch(() => null));
      return (await res.json() as { deleted: number }).deleted;
    },

    async incr(key: string, by?: number): Promise<number> {
      const body = by !== undefined ? { by } : {};
      const res = await call('POST', `${key}/incr`, body);
      if (!res.ok) throwForStatus(res, await res.json().catch(() => null));
      return (await res.json() as { value: number }).value;
    },

    async decr(key: string, by?: number): Promise<number> {
      const body = by !== undefined ? { by } : {};
      const res = await call('POST', `${key}/decr`, body);
      if (!res.ok) throwForStatus(res, await res.json().catch(() => null));
      return (await res.json() as { value: number }).value;
    },

    async setnx(key: string, value: unknown, opts?: { ttl?: number | null; ephemeral?: boolean }): Promise<boolean> {
      const body: Record<string, unknown> = { value };
      if (opts?.ttl !== undefined) body.ttl = opts.ttl;
      if (opts?.ephemeral !== undefined) body.ephemeral = opts.ephemeral;
      const res = await call('POST', `${key}/setnx`, body);
      if (res.status === 201) return true;
      if (res.status === 200) return false;
      throwForStatus(res, await res.json().catch(() => null));
    },

    async setex(key: string, value: unknown, ttl: number, opts?: { ephemeral?: boolean }): Promise<void> {
      return this.set(key, value, { ttl, ephemeral: opts?.ephemeral });
    },

    async cas(key: string, expected: unknown, next: unknown): Promise<boolean> {
      const res = await call('POST', `${key}/cas`, { expected, next });
      if (!res.ok) throwForStatus(res, await res.json().catch(() => null));
      return (await res.json() as { swapped: boolean }).swapped;
    },

    async exists(key: string): Promise<boolean> {
      const res = await call('GET', `${key}/exists`);
      if (!res.ok) throwForStatus(res, await res.json().catch(() => null));
      return (await res.json() as { exists: boolean }).exists;
    },

    async ttl(key: string): Promise<number | null> {
      const res = await call('GET', `${key}/ttl`);
      if (res.status === 404) return null;
      if (!res.ok) throwForStatus(res, await res.json().catch(() => null));
      return (await res.json() as { ttl: number | null }).ttl;
    },

    async expire(key: string, ttl: number | null): Promise<boolean> {
      const res = await call('POST', `${key}/expire`, { ttl });
      if (!res.ok) throwForStatus(res, await res.json().catch(() => null));
      return (await res.json() as { applied: boolean }).applied;
    },

    async mget<T>(keys: string[]): Promise<(T | null)[]> {
      const ops = keys.map((key) => ({ op: 'get', key }));
      const res = await call('POST', '_batch', { ops });
      if (!res.ok) throwForStatus(res, await res.json().catch(() => null));
      const { results } = await res.json() as { results: ({ value: T } | { error: string })[] };
      return results.map((r) => {
        if ('error' in r) return null;
        if ('value' in r) return r.value;
        throw new KvError('unexpected batch result shape', 'KV_BATCH_SHAPE', 500);
      });
    },

    async mset(entries: Record<string, unknown>, opts?: { ttl?: number | null }): Promise<void> {
      // Uses parallel PUTs — gateway batch does not honor ttl/ephemeral for set ops.
      await Promise.all(
        Object.entries(entries).map(([key, value]) => this.set(key, value, opts)),
      );
    },

    async expose(pattern: string, opts: { read: Role; write: Role }): Promise<void> {
      const res = await call('PUT', `_expose/${encodeURIComponent(pattern)}`, opts);
      if (res.status === 204) return;
      if (!res.ok) throwForStatus(res, await res.json().catch(() => null));
    },

    async unexpose(pattern: string): Promise<number> {
      const res = await call('DELETE', `_expose/${encodeURIComponent(pattern)}`);
      if (!res.ok) throwForStatus(res, await res.json().catch(() => null));
      return (await res.json() as { deleted: number }).deleted;
    },

    async listRules(): Promise<Array<{ pattern: string; read: Role; write: Role; order: number }>> {
      const res = await call('GET', '_expose');
      if (!res.ok) throwForStatus(res, await res.json().catch(() => null));
      return (await res.json() as { rules: Array<{ pattern: string; read: Role; write: Role; order: number }> }).rules;
    },
  };
}
