import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReferenceImageLoader } from './reference-image.js';
import type { AssetScope } from './reference-assets.js';

const scope: AssetScope = { organizationId: 'org', appId: 'app', endUserSub: null, providerSlot: 'slot', credentialNamespace: 'namespace' };
const publicAddress = { address: '93.184.216.34', family: 4 };
const image = () => sharp({ create: { width: 2, height: 3, channels: 3, background: 'red' } }).png().toBuffer();
type Reply = { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; hang?: boolean };
function fixture(replies: Reply[], lookup = async (_host: string) => [publicAddress]) {
  const options: RequestOptions[] = [];
  const streams: PassThrough[] = [];
  const requests: Array<EventEmitter & { destroy: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }> = [];
  const request = (opts: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
    options.push(opts);
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected request');
    const req = Object.assign(new EventEmitter(), {
      destroy: vi.fn(function(this: EventEmitter, err?: Error) { if (err) queueMicrotask(() => this.emit('error', err)); return this; }),
      end: vi.fn(() => queueMicrotask(() => {
        if (reply.hang) return;
        const response = Object.assign(new PassThrough(), { statusCode: reply.status ?? 200, headers: { 'content-type': 'image/png', ...reply.headers } });
        streams.push(response);
        callback(response as unknown as IncomingMessage);
        for (const chunk of reply.chunks ?? []) response.write(chunk);
        response.end();
      })),
    });
    requests.push(req);
    return req as unknown as ClientRequest;
  };
  return { load: createReferenceImageLoader({ lookup, request }), options, streams, requests };
}
afterEach(() => vi.useRealTimers());

describe('reference image exact-byte loading', () => {
  it('hashes identical bytes at different URLs equally and returns the exact original bytes', async () => {
    const bytes = await image();
    const { load } = fixture([{ chunks: [bytes.subarray(0, 8), bytes.subarray(8)] }, { chunks: [bytes] }]);
    const a = await load(scope, 'https://one.example/image?signature=1');
    const b = await load(scope, 'https://two.example/image?signature=2');
    expect(a.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(b.sha256).toBe(a.sha256);
    expect(a.bytesHandle).toEqual(bytes);
    expect(a.byteLength).toBe(bytes.length);
    expect(a.mimeType).toBe('image/png');
    a.bytesHandle.fill(0);
    expect(a.bytesHandle).toEqual(bytes);
  });
  it('refetches the same URL and fingerprints changed bytes separately', async () => {
    const a = await image();
    const b = await sharp(a).jpeg().toBuffer();
    const { load } = fixture([{ chunks: [a] }, { chunks: [b], headers: { 'content-type': 'image/jpeg' } }]);
    const first = await load(scope, 'https://one.example/image');
    const second = await load(scope, 'https://one.example/image');
    expect(first.sha256).not.toBe(second.sha256);
  });
  it.each([401, 403, 404, 410])('rejects expired/inaccessible URLs with HTTP %s', async (status) => {
    const f = fixture([{ status }]);
    await expect(f.load(scope, 'https://one.example/a')).rejects.toThrow(/HTTP/);
    expect(f.streams.every(s => s.destroyed)).toBe(true);
  });
  it.each(['text/html', 'image/svg+xml', 'image/gif'])('rejects unsupported content type %s', async (type) => {
    const f = fixture([{ chunks: [await image()], headers: { 'content-type': type } }]);
    await expect(f.load(scope, 'https://one.example/a')).rejects.toThrow(/media type/);
  });
  it.each(['invalid', 'truncated', 'mismatched'])('rejects %s image bytes', async (kind) => {
    const png = await image();
    const bytes = kind === 'invalid' ? Buffer.from('not a PNG') : kind === 'truncated' ? png.subarray(0, 40) : await sharp(png).jpeg().toBuffer();
    const f = fixture([{ chunks: [bytes] }]);
    await expect(f.load(scope, 'https://one.example/a')).rejects.toThrow(/image/);
  });
  it('accepts WebP while preserving encoded bytes', async () => {
    const bytes = await sharp(await image()).webp().toBuffer();
    const f = fixture([{ chunks: [bytes], headers: { 'content-type': 'image/webp' } }]);
    expect((await f.load(scope, 'https://one.example/a')).bytesHandle).toEqual(bytes);
  });
  it('rejects decoded pixel bombs before full decode', async () => {
    const bytes = await sharp({ create: { width: 7000, height: 7000, channels: 3, background: 'red' } }).png().toBuffer();
    const f = fixture([{ chunks: [bytes] }]);
    await expect(f.load(scope, 'https://one.example/a')).rejects.toThrow(/pixel|image/i);
  });
  it('bounds streamed bytes without trusting Content-Length and destroys streams', async () => {
    const f = fixture([{ chunks: [Buffer.alloc(6 * 1024 * 1024), Buffer.alloc(5 * 1024 * 1024)] }]);
    await expect(f.load(scope, 'https://one.example/a')).rejects.toThrow(/10 MiB/);
    expect(f.streams[0].destroyed).toBe(true);
  });
  it('rejects oversized Content-Length and encoded HTTP bodies', async () => {
    for (const headers of [{ 'content-length': '10485761' }, { 'content-encoding': 'gzip' }]) {
      const f = fixture([{ headers }]);
      await expect(f.load(scope, 'https://one.example/a')).rejects.toThrow();
      expect(f.streams[0].destroyed).toBe(true);
    }
  });
});

describe('reference image SSRF and lifecycle policy', () => {
  it('pins a validated address in the actual request lookup and preserves TLS SNI and hostname', async () => {
    const resolve = vi.fn(async () => [publicAddress, { address: '2606:4700:4700::1111', family: 6 }]);
    const f = fixture([{ chunks: [await image()] }], resolve);
    await f.load(scope, 'https://one.example:8443/image?signature=secret');
    const opts = f.options[0];
    expect(opts.hostname).toBe('one.example');
    expect(opts.servername).toBe('one.example');
    expect(opts.port).toBe('8443');
    expect(opts.agent).toBe(false);
    expect(opts.headers).toEqual({ Accept: 'image/png,image/jpeg,image/webp', 'Accept-Encoding': 'identity' });
    const callback = vi.fn();
    (opts.lookup as Function)('one.example', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [publicAddress]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1', '64:ff9b::a00:1'])('rejects non-global DNS address %s even in mixed answers', async (address) => {
    const f = fixture([], async () => [publicAddress, { address, family: address.includes(':') ? 6 : 4 }]);
    await expect(f.load(scope, 'https://one.example/a')).rejects.toThrow(/public|global/);
    expect(f.options).toHaveLength(0);
  });
  it.each(['http://one.example/a', 'https://user:pass@one.example/a', 'https://127.1/a', 'https://[::ffff:7f00:1]/a', 'object-id', 'https://localhost/a'])('rejects unsafe URL %s', async (url) => {
    const f = fixture([]);
    await expect(f.load(scope, url)).rejects.toThrow();
    expect(f.options).toHaveLength(0);
  });
  it('resolves and checks each redirect before connecting, including public-to-private DNS', async () => {
    const f = fixture([{ status: 302, headers: { location: 'https://private.example/a' } }], async host => host === 'private.example' ? [{ address: '10.0.0.1', family: 4 }] : [publicAddress]);
    await expect(f.load(scope, 'https://one.example/a')).rejects.toThrow(/global|public/);
    expect(f.options).toHaveLength(1);
    expect(f.streams[0].destroyed).toBe(true);
  });
  it.each(['http://one.example/a', 'https://user:password@one.example/a', 'https://[::1]/a'])('rejects unsafe redirect %s without forwarding credentials', async location => {
    const f = fixture([{ status: 307, headers: { location } }]);
    await expect(f.load(scope, 'https://one.example/a?token=private')).rejects.toThrow();
    expect(f.options).toHaveLength(1);
    expect(f.streams[0].destroyed).toBe(true);
  });
  it('bounds total time while waiting for response headers', async () => {
    vi.useFakeTimers();
    const f = fixture([{ hang: true }]);
    const rejected = expect(f.load(scope, 'https://one.example/a')).rejects.toThrow(/time/i);
    await vi.advanceTimersByTimeAsync(20_001);
    await rejected;
    expect(f.requests[0].destroy).toHaveBeenCalled();
  });
  it('follows relative redirects and enforces three redirects across the whole load', async () => {
    const good = fixture([{ status: 302, headers: { location: '/new' } }, { chunks: [await image()] }]);
    await good.load(scope, 'https://one.example/a');
    expect(good.options[1].path).toBe('/new');
    const loop = fixture(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/again' } })));
    await expect(loop.load(scope, 'https://one.example/a')).rejects.toThrow(/redirect/);
    expect(loop.options).toHaveLength(4);
  });
  it('aborts pending requests and cleans resources', async () => {
    const f = fixture([{ hang: true }]);
    const abort = new AbortController();
    const promise = f.load(scope, 'https://one.example/a', abort.signal);
    const rejected = expect(promise).rejects.toThrow(/abort/i);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    abort.abort();
    await rejected;
    expect(f.requests[0].destroy).toHaveBeenCalled();
  });
  it('bounds total time including a hanging DNS lookup', async () => {
    vi.useFakeTimers();
    const f = fixture([], () => new Promise(() => {}));
    const result = expect(f.load(scope, 'https://one.example/a')).rejects.toThrow(/time|abort/i);
    await vi.advanceTimersByTimeAsync(20_001);
    await result;
    expect(f.options).toHaveLength(0);
  });
  it('aborts a stalled response body and releases the download stream', async () => {
    const f = fixture([{ chunks: [] }]);
    const controller = new AbortController();
    // Prevent the response body from completing while retaining real stream behavior.
    const originalRequest = f.load;
    const spy = vi.spyOn(PassThrough.prototype, 'end').mockImplementation(function(this: PassThrough) { return this; });
    try {
      const rejected = expect(originalRequest(scope, 'https://one.example/a', controller.signal)).rejects.toThrow(/abort/i);
      await vi.waitFor(() => expect(f.streams).toHaveLength(1));
      controller.abort();
      await rejected;
      expect(f.streams[0].destroyed).toBe(true);
    } finally { spy.mockRestore(); }
  });
  it('limits concurrent downloads to two without retaining an unbounded queue', async () => {
    const f = fixture([{ hang: true }, { hang: true }]);
    const controller = new AbortController();
    const first = expect(f.load(scope, 'https://one.example/a', controller.signal)).rejects.toThrow(/abort/i);
    const second = expect(f.load(scope, 'https://one.example/b', controller.signal)).rejects.toThrow(/abort/i);
    await vi.waitFor(() => expect(f.options).toHaveLength(2));
    try { await expect(f.load(scope, 'https://one.example/c')).rejects.toMatchObject({ code: 'REFERENCE_IMAGE_CAPACITY_EXCEEDED', retryable: true }); }
    finally { controller.abort(); await Promise.all([first, second]); }
  });
  it('rejects an already aborted caller before opening a request', async () => {
    const f = fixture([]);
    const controller = new AbortController(); controller.abort();
    await expect(f.load(scope, 'https://one.example/a', controller.signal)).rejects.toThrow(/abort/i);
    expect(f.options).toHaveLength(0);
  });
});
