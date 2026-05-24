// Per-region ioredis subscriber that listens to keyspace expiry events and
// decrements the per-app keys counter. Required Redis config:
//   notify-keyspace-events Ex   (E = keyevent, x = expired)

import { Redis } from 'ioredis';
import { decKeys } from './keys-counter.js';
import { decBytes } from './storage-counter.js';
import { RedisClient, type RedisClientOptions } from './redis-client.js';

const USER_KEY_RE = /^\{([^}]+)\}:u:/;

export interface KeysExpiryWorker {
  stop(): Promise<void>;
}

export interface StartKeysExpiryWorkerOpts {
  regions: string[];
  urlForRegion: (region: string) => string;
  log: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
}

function parseOpts(url: string): Omit<RedisClientOptions, 'db'> {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 6379,
    password: u.password ? decodeURIComponent(u.password) : '',
  };
}

export function startKeysExpiryWorker(opts: StartKeysExpiryWorkerOpts): KeysExpiryWorker {
  const subs: Redis[] = [];
  const writers = new Map<string, RedisClient>();
  const writerInflight = new Map<string, Promise<RedisClient>>();

  async function getWriter(region: string): Promise<RedisClient> {
    let w = writers.get(region);
    if (w) return w;
    let pending = writerInflight.get(region);
    if (pending) return pending;
    pending = (async () => {
      const c = await RedisClient.connect({ ...parseOpts(opts.urlForRegion(region)), db: 0 });
      writers.set(region, c);
      writerInflight.delete(region);
      return c;
    })();
    writerInflight.set(region, pending);
    return pending;
  }

  for (const region of opts.regions) {
    const url = opts.urlForRegion(region);
    const sub = new Redis(url);

    sub.on('error', (err) => {
      opts.log.warn({ region, err: (err as Error).message }, '[keys-expiry] subscriber error');
    });

    sub.on('ready', () => {
      sub.subscribe('__keyevent@0__:expired', '__keyevent@1__:expired').catch((err) => {
        opts.log.error({ region, err: (err as Error).message }, '[keys-expiry] subscribe failed');
      });
      opts.log.info({ region }, '[keys-expiry] subscribed');
    });

    sub.on('message', async (_channel, key) => {
      const m = USER_KEY_RE.exec(key);
      if (!m) return;
      const appId = m[1];
      const prefix = `{${appId}}:u:`;
      const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : null;
      try {
        const writer = await getWriter(region);
        let size: number | null = null;
        if (suffix !== null) {
          const raw = await writer.hget(`{${appId}}:_meta:bytes_idx`, suffix);
          const parsed = raw !== null ? parseInt(raw, 10) : NaN;
          size = Number.isFinite(parsed) ? parsed : null;
          await writer.hdel(`{${appId}}:_meta:bytes_idx`, [suffix]);
        }
        await decKeys(writer, appId, 1);
        if (size !== null && size > 0) await decBytes(writer, appId, size);
      } catch (err) {
        opts.log.warn({ region, key, err: (err as Error).message }, '[keys-expiry] decrement failed');
      }
    });

    subs.push(sub);
  }

  return {
    async stop() {
      await Promise.all(subs.map((s) => s.quit().catch(() => {})));
      for (const w of writers.values()) await w.close().catch(() => {});
      writers.clear();
    },
  };
}
