import { createHash } from 'node:crypto';
import type { ChatCompletionRequest } from './schemas.js';
export type { RouterName } from './normalize.js';
import type { RouterName } from './normalize.js';

// ---------------------------------------------------------------------------
// KV interface — narrow contract consumed by this module.
// The production adapter wraps ioredis (see services/redis.ts); tests supply
// an in-memory fixture.
// ---------------------------------------------------------------------------

export interface KVClient {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// StickyBindings — router-choice persistence
// ---------------------------------------------------------------------------

export interface StickyBindings {
  get(key: string): Promise<RouterName | null>;
  set(key: string, router: RouterName, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createStickyBindings(kv: KVClient): StickyBindings {
  return {
    async get(key) {
      const v = await kv.get(key);
      return v as RouterName | null;
    },
    async set(key, router, ttlSeconds) {
      await kv.put(key, router, { expirationTtl: ttlSeconds });
    },
    async delete(key) {
      await kv.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// ioredis adapter — wraps an ioredis client to match the KVClient interface.
// The KVClient contract uses get/put/delete; ioredis uses get/set/setex/del.
// ---------------------------------------------------------------------------

interface IoredisLike {
  get(key: string): Promise<string | null>;
  set(...args: any[]): Promise<any>;
  del(key: string): Promise<any>;
}

export function createStickyBindingsFromRedis(redis: IoredisLike): StickyBindings {
  const kv: KVClient = {
    get: (key) => redis.get(key),
    put: async (key, value, opts) => {
      const ttl = opts?.expirationTtl;
      if (typeof ttl === 'number' && ttl > 0) {
        await redis.set(key, value, 'EX', ttl);
      } else {
        await redis.set(key, value);
      }
    },
    delete: async (key) => { await redis.del(key); },
  };
  return createStickyBindings(kv);
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

export const sessionKey = (id: string): string => `ai-router:sticky:session:${id}`;
export const prefixKey = (hash: string): string => `ai-router:sticky:prefix:${hash}`;

// ---------------------------------------------------------------------------
// Prefix hasher — excludes the last message (the current user turn) so that
// the hash is stable across turns in the same conversation context.
// ---------------------------------------------------------------------------

export function hashCacheablePrefix(req: ChatCompletionRequest): string {
  const tools = (req as any).tools ?? [];
  const messages = req.messages ?? [];
  const prefix = messages.slice(0, Math.max(0, messages.length - 1));
  const canon = JSON.stringify({ tools, prefix });
  return createHash('sha256').update(canon).digest('hex');
}

// ---------------------------------------------------------------------------
// TTL helper
// ---------------------------------------------------------------------------

export function ttlSecondsFor(req: ChatCompletionRequest): number {
  return req.cache_control?.ttl === '1h' ? 3600 : 300;
}
