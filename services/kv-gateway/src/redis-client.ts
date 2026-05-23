// src/redis-client.ts
// Minimal RESP2 client. Uses cloudflare:sockets in Worker runtime, node:net in tests.
// Implements: AUTH, SELECT, GET, SET, DEL, FLUSHDB, SETEX, SETNX (via SET NX),
//             INCRBY, DECRBY, EXISTS, TTL, EXPIRE, PERSIST, MGET, MSET, EVAL,
//             and a generic SET-with-options helper.

interface Socket {
  write(data: Uint8Array): Promise<void> | void;
  readChunk(): Promise<Uint8Array | null>;
  close(): Promise<void> | void;
}

async function openSocket(host: string, port: number): Promise<Socket> {
  // In Workers runtime, the `cloudflare:sockets` import resolves; in Node tests we fall back.
  // Heuristic: WebSocketPair is a Workers-only global.
  if (typeof (globalThis as any).WebSocketPair !== 'undefined') {
    const { connect } = await import('cloudflare:sockets' as any);
    const s = connect({ hostname: host, port });
    const reader = s.readable.getReader();
    const writer = s.writable.getWriter();
    return {
      write: (d) => writer.write(d),
      readChunk: async () => {
        const { value, done } = await reader.read();
        return done ? null : value;
      },
      close: async () => { await writer.close(); },
    };
  } else {
    // Node.js fallback for test environment.
    // Types are suppressed: the Workers tsconfig has no @types/node, so node:net
    // and Node Buffer are unknown to TypeScript here. The code is correct at runtime.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const netMod: any = await import('node:net' as any);
    return await new Promise<Socket>((resolve, reject) => {
      const sock: any = netMod.createConnection(port, host);
      const queue: Uint8Array[] = [];
      const waiters: Array<(v: Uint8Array | null) => void> = [];
      sock.on('data', (buf: any) => {
        // buf is a Node Buffer; Uint8Array constructor accepts it
        const chunk = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        if (waiters.length) waiters.shift()!(chunk);
        else queue.push(chunk);
      });
      sock.on('error', reject);
      sock.on('connect', () => {
        resolve({
          write: (d: Uint8Array) =>
            new Promise<void>((res, rej) =>
              sock.write(d, (e: any) => (e ? rej(e) : res()))
            ),
          readChunk: () =>
            queue.length
              ? Promise.resolve(queue.shift()!)
              : new Promise<Uint8Array | null>((res) => waiters.push(res)),
          close: () => new Promise<void>((res) => sock.end(() => res())),
        });
      });
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function encodeCommand(parts: string[]): Uint8Array {
  let s = `*${parts.length}\r\n`;
  for (const p of parts) {
    const bytes = enc.encode(p);
    s += `$${bytes.length}\r\n${p}\r\n`;
  }
  return enc.encode(s);
}

// Top-level alias for any value that can come back from RESP2.
type RespValue = string | number | null | Error | RespValue[];

class Reader {
  private buf = new Uint8Array(0);
  constructor(private readonly socket: Socket) {}
  private async fill(min: number) {
    while (this.buf.length < min) {
      const chunk = await this.socket.readChunk();
      if (!chunk) throw new Error('socket closed');
      const next = new Uint8Array(this.buf.length + chunk.length);
      next.set(this.buf);
      next.set(chunk, this.buf.length);
      this.buf = next;
    }
  }
  private async readLine(): Promise<string> {
    while (true) {
      const idx = this.buf.indexOf(0x0a);
      if (idx >= 0 && this.buf[idx - 1] === 0x0d) {
        const line = dec.decode(this.buf.subarray(0, idx - 1));
        this.buf = this.buf.subarray(idx + 1);
        return line;
      }
      await this.fill(this.buf.length + 1);
    }
  }
  async readReply(): Promise<RespValue> {
    const line = await this.readLine();
    const type = line[0];
    const rest = line.slice(1);
    if (type === '+') return rest;
    if (type === '-') return new Error(rest);
    if (type === ':') return Number(rest);
    if (type === '$') {
      const len = Number(rest);
      if (len === -1) return null;
      await this.fill(len + 2);
      const out = dec.decode(this.buf.subarray(0, len));
      this.buf = this.buf.subarray(len + 2);
      return out;
    }
    if (type === '*') {
      const n = Number(rest);
      if (n === -1) return null;
      const out: RespValue[] = [];
      for (let i = 0; i < n; i++) {
        out.push(await this.readReply());
      }
      return out;
    }
    throw new Error(`unexpected RESP type: ${type}`);
  }
}

export interface RedisClientOptions {
  host: string;
  port: number;
  password: string;
  db?: number; // default 0
}

export class RedisClient {
  private constructor(private readonly socket: Socket, private readonly reader: Reader) {}

  static async connect(opts: RedisClientOptions): Promise<RedisClient> {
    const sock = await openSocket(opts.host, opts.port);
    const reader = new Reader(sock);
    const client = new RedisClient(sock, reader);
    const auth = await client.send(['AUTH', opts.password]);
    if (auth instanceof Error) {
      await client.close();
      throw new Error(`AUTH failed: ${auth.message}`);
    }
    if (opts.db !== undefined) {
      const sel = await client.send(['SELECT', String(opts.db)]);
      if (sel instanceof Error) {
        await client.close();
        throw sel;
      }
    }
    return client;
  }

  private async send(cmd: string[]): Promise<RespValue> {
    await this.socket.write(encodeCommand(cmd));
    return this.reader.readReply();
  }

  async get(key: string): Promise<string | null> {
    const r = await this.send(['GET', key]);
    if (r instanceof Error) throw r;
    return r === null ? null : String(r);
  }

  async set(key: string, value: string): Promise<void> {
    const r = await this.send(['SET', key, value]);
    if (r instanceof Error) throw r;
  }

  async del(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const r = await this.send(['DEL', ...keys]);
    if (r instanceof Error) throw r;
    return Number(r);
  }

  async flushTestDb(): Promise<void> {
    const r = await this.send(['FLUSHDB']);
    if (r instanceof Error) throw r;
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    const r = await this.send(['SETEX', key, String(ttlSeconds), value]);
    if (r instanceof Error) throw r;
  }

  async setnx(key: string, value: string): Promise<boolean> {
    // Use SET key value NX for consistency with setWithOptions
    const r = await this.send(['SET', key, value, 'NX']);
    if (r instanceof Error) throw r;
    return r !== null; // +OK → true; nil → false
  }

  async incrBy(key: string, by: number): Promise<number> {
    const r = await this.send(['INCRBY', key, String(by)]);
    if (r instanceof Error) throw r;
    return Number(r);
  }

  async decrBy(key: string, by: number): Promise<number> {
    const r = await this.send(['DECRBY', key, String(by)]);
    if (r instanceof Error) throw r;
    return Number(r);
  }

  async exists(key: string): Promise<boolean> {
    const r = await this.send(['EXISTS', key]);
    if (r instanceof Error) throw r;
    return Number(r) === 1;
  }

  async ttl(key: string): Promise<number> {
    const r = await this.send(['TTL', key]);
    if (r instanceof Error) throw r;
    return Number(r);
  }

  async expire(key: string, ttlSeconds: number | null): Promise<boolean> {
    const r = ttlSeconds === null
      ? await this.send(['PERSIST', key])
      : await this.send(['EXPIRE', key, String(ttlSeconds)]);
    if (r instanceof Error) throw r;
    return Number(r) === 1;
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    const r = await this.send(['MGET', ...keys]);
    if (r instanceof Error) throw r;
    if (!Array.isArray(r)) throw new Error('unexpected MGET reply');
    return r.map((v) => {
      if (v === null) return null;
      if (v instanceof Error) throw v;
      return String(v);
    });
  }

  async mset(pairs: Array<[string, string]>): Promise<void> {
    if (pairs.length === 0) return;
    const flat: string[] = ['MSET'];
    for (const [k, v] of pairs) {
      flat.push(k, v);
    }
    const r = await this.send(flat);
    if (r instanceof Error) throw r;
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    const r = await this.send(['HSET', key, field, value]);
    if (r instanceof Error) throw r;
  }

  async hdel(key: string, fields: string[]): Promise<number> {
    if (fields.length === 0) return 0;
    const r = await this.send(['HDEL', key, ...fields]);
    if (r instanceof Error) throw r;
    return Number(r);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const r = await this.send(['HGETALL', key]);
    if (r instanceof Error) throw r;
    if (!Array.isArray(r)) throw new Error('hgetall: expected array reply');
    const out: Record<string, string> = {};
    for (let i = 0; i < r.length; i += 2) {
      out[String(r[i])] = String(r[i + 1]);
    }
    return out;
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    const cmd = ['EVAL', script, String(keys.length), ...keys, ...args];
    const r = await this.send(cmd);
    if (r instanceof Error) throw r;
    return r;
  }

  async setWithOptions(
    key: string,
    value: string,
    opts: { ex?: number; nx?: boolean; xx?: boolean },
  ): Promise<boolean> {
    if (opts.nx && opts.xx) throw new Error('setWithOptions: nx and xx are mutually exclusive');
    const cmd = ['SET', key, value];
    if (opts.ex !== undefined) cmd.push('EX', String(opts.ex));
    if (opts.nx) cmd.push('NX');
    else if (opts.xx) cmd.push('XX');
    const r = await this.send(cmd);
    if (r instanceof Error) throw r;
    return r !== null; // +OK → true; nil → false (NX/XX condition failed)
  }

  async close(): Promise<void> {
    await this.socket.close();
  }
}
