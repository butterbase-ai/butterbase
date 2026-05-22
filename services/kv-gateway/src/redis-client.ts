// src/redis-client.ts
// Minimal RESP2 client. Uses cloudflare:sockets in Worker runtime, node:net in tests.
// Implements only: AUTH, SELECT, GET, SET, DEL, FLUSHDB.

interface Socket {
  write(data: Uint8Array): Promise<void> | void;
  readChunk(): Promise<Uint8Array | null>;
  close(): Promise<void> | void;
}

async function openSocket(host: string, port: number): Promise<Socket> {
  // In Workers runtime, the `cloudflare:sockets` import resolves; in Node tests we fall back.
  // Heuristic: WebSocketPair is a Workers-only global.
  if (typeof (globalThis as any).WebSocketPair !== 'undefined') {
    // @ts-expect-error cloudflare:sockets only available in Workers runtime
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
    const { createConnection } = await import('node:net');
    return await new Promise<Socket>((resolve, reject) => {
      const sock = createConnection(port, host);
      const queue: Uint8Array[] = [];
      const waiters: Array<(v: Uint8Array | null) => void> = [];
      sock.on('data', (buf: Buffer) => {
        const chunk = new Uint8Array(buf);
        if (waiters.length) waiters.shift()!(chunk);
        else queue.push(chunk);
      });
      sock.on('error', reject);
      sock.on('connect', () => {
        resolve({
          write: (d) =>
            new Promise<void>((res, rej) => sock.write(Buffer.from(d), (e) => (e ? rej(e) : res()))),
          readChunk: () =>
            queue.length
              ? Promise.resolve(queue.shift()!)
              : new Promise<Uint8Array | null>((res) => waiters.push(res)),
          close: () => new Promise<void>((res) => sock.end(() => res())),
        });
      });
    });
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
  async readReply(): Promise<string | number | null | Error> {
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

  private async send(cmd: string[]): Promise<string | number | null | Error> {
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
    const r = await this.send(['DEL', ...keys]);
    if (r instanceof Error) throw r;
    return Number(r);
  }

  async flushTestDb(): Promise<void> {
    const r = await this.send(['FLUSHDB']);
    if (r instanceof Error) throw r;
  }

  async close(): Promise<void> {
    await this.socket.close();
  }
}
