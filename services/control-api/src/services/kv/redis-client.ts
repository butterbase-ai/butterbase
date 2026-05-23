// services/control-api/src/services/kv/redis-client.ts
// ioredis-backed RedisClient wrapper that matches the interface used by
// kv-gateway's admin.ts, expose.ts, and keys.ts so those files compile
// unchanged after being copied here.
//
// Public API:
//   RedisClient.connect(opts)  — static factory (used by admin.ts)
//   wrap(ioRedis)              — factory from an existing ioredis instance

import { Redis } from 'ioredis';

export interface RedisClientOptions {
  host: string;
  port: number;
  password: string;
  db?: number; // default 0
}

export class RedisClient {
  private constructor(private readonly io: Redis) {}

  // Static factory — mirrors gateway's RedisClient.connect(opts).
  // Creates a fresh ioredis connection per call; caller must call close().
  static async connect(opts: RedisClientOptions): Promise<RedisClient> {
    const io = new Redis({
      host: opts.host,
      port: opts.port,
      password: opts.password,
      db: opts.db ?? 0,
      lazyConnect: true,
      enableReadyCheck: false,
    });
    await io.connect();
    return new RedisClient(io);
  }

  async close(): Promise<void> {
    await this.io.quit();
  }

  // ── String commands ────────────────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    return this.io.get(key);
  }

  // Plain SET (no options). Used by batch ops and CAS Lua restore.
  async set(key: string, value: string): Promise<void> {
    await this.io.set(key, value);
  }

  async del(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.io.del(...keys);
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    await this.io.setex(key, ttlSeconds, value);
  }

  async setnx(key: string, value: string): Promise<boolean> {
    // ioredis setnx returns 1 (success) or 0 (key exists).
    const r = await this.io.setnx(key, value);
    return r === 1;
  }

  async incrBy(key: string, by: number): Promise<number> {
    return this.io.incrby(key, by);
  }

  async decrBy(key: string, by: number): Promise<number> {
    return this.io.decrby(key, by);
  }

  async exists(key: string): Promise<boolean> {
    const r = await this.io.exists(key);
    return r === 1;
  }

  async ttl(key: string): Promise<number> {
    return this.io.ttl(key);
  }

  async pttl(key: string): Promise<number> {
    return this.io.pttl(key);
  }

  // expire(key, null) → PERSIST; expire(key, n) → EXPIRE key n
  async expire(key: string, ttlSeconds: number | null): Promise<boolean> {
    if (ttlSeconds === null) {
      const r = await this.io.persist(key);
      return r === 1;
    }
    const r = await this.io.expire(key, ttlSeconds);
    return r === 1;
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    return this.io.mget(...keys);
  }

  async mset(pairs: Array<[string, string]>): Promise<void> {
    if (pairs.length === 0) return;
    const flat: string[] = [];
    for (const [k, v] of pairs) flat.push(k, v);
    await this.io.mset(...flat);
  }

  // SET with options (NX / XX / EX). Returns true when write succeeded.
  async setWithOptions(
    key: string,
    value: string,
    opts: { ex?: number; nx?: boolean; xx?: boolean },
  ): Promise<boolean> {
    if (opts.nx && opts.xx) throw new Error('setWithOptions: nx and xx are mutually exclusive');
    // ioredis SET with options returns 'OK' or null.
    let result: string | null;
    if (opts.nx) {
      result = opts.ex !== undefined
        ? await this.io.set(key, value, 'EX', opts.ex, 'NX')
        : await this.io.set(key, value, 'NX');
    } else if (opts.xx) {
      result = opts.ex !== undefined
        ? await this.io.set(key, value, 'EX', opts.ex, 'XX')
        : await this.io.set(key, value, 'XX');
    } else {
      result = opts.ex !== undefined
        ? await this.io.set(key, value, 'EX', opts.ex)
        : await this.io.set(key, value);
    }
    return result !== null; // 'OK' → true; null (NX/XX failed) → false
  }

  // ── Scan / memory ──────────────────────────────────────────────────────────

  // SCAN cursor MATCH pattern COUNT count → [nextCursor, keys[]]
  async scan(cursor: string, match: string, count: number): Promise<[string, string[]]> {
    const [nextCursor, keys] = await this.io.scan(cursor, 'MATCH', match, 'COUNT', count);
    return [nextCursor, keys];
  }

  async unlink(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.io.unlink(...keys);
  }

  async memoryUsage(key: string): Promise<number | null> {
    // ioredis does not type MEMORY USAGE natively; use sendCommand.
    try {
      const r = await (this.io as any).call('MEMORY', 'USAGE', key) as number | null;
      return r ?? null;
    } catch {
      return null; // best-effort, match gateway semantics
    }
  }

  // ── Lua eval ───────────────────────────────────────────────────────────────

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.io.eval(script, keys.length, ...keys, ...args);
  }

  // ── Hash commands ──────────────────────────────────────────────────────────

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.io.hset(key, field, value);
  }

  async hdel(key: string, fields: string[]): Promise<number> {
    if (fields.length === 0) return 0;
    return this.io.hdel(key, ...fields);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.io.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const r = await this.io.hgetall(key);
    // ioredis returns {} when key does not exist (not null).
    return r ?? {};
  }

  // ── Test helpers ───────────────────────────────────────────────────────────

  /** FLUSHDB — only used in test environments. */
  async flushTestDb(): Promise<void> {
    await this.io.flushdb();
  }
}

/**
 * Wrap an existing ioredis instance as a RedisClient.
 * The caller retains ownership of the ioredis connection's lifecycle;
 * calling close() on the returned RedisClient will QUIT the connection.
 */
export function wrap(ioRedis: Redis): RedisClient {
  // Access the private constructor via a cast — safe because this module owns both.
  return new (RedisClient as any)(ioRedis) as RedisClient;
}
