import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import sharp from 'sharp';
import type { AssetScope } from './reference-assets.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const DOWNLOAD_MS = 20_000;
const MAX_REDIRECTS = 3;
const mimeFormats: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };

// Fail closed for special-use/non-global ranges. IPv6 permits global unicast
// only, excluding transition mechanisms and reserved/documentation allocations.
const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) denied.addSubnet(address, prefix, 'ipv6');

function assertGlobal(address: string): void {
  const family = isIP(address);
  if (!family || (family === 4 ? denied.check(address, 'ipv4') : !globalV6.check(address, 'ipv6') || denied.check(address, 'ipv6'))) {
    throw new Error('Reference image requires public global network addresses');
  }
}
function parseUrl(source: string): URL {
  let url: URL;
  try { url = new URL(source); } catch { throw new Error('Reference image requires an HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) throw new Error('Reference image requires an HTTPS URL without userinfo');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Reference image requires a public hostname');
  if (isIP(host)) assertGlobal(host);
  return url;
}

export interface LoadedReferenceImage {
  readonly sha256: string;
  /** Each read returns a copy: caller mutation cannot change the hashed bytes. */
  readonly bytesHandle: Buffer;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly byteLength: number;
}
export class ReferenceImageCapacityError extends Error {
  readonly code = 'REFERENCE_IMAGE_CAPACITY_EXCEEDED';
  readonly retryable = true;
  constructor() { super('Reference image concurrent download limit reached'); this.name = 'ReferenceImageCapacityError'; }
}

export interface ReferenceImageDependencies {
  lookup(hostname: string): Promise<LookupAddress[]>;
  request(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest;
}

/**
 * URL inputs must already be authorized by the caller in this scope. No URL
 * identity cache: every invocation downloads and fingerprints the actual bytes.
 * Future object sources must resolve fresh URLs through storage's real ownership
 * and public-read rules; arbitrary strings must never become storage object IDs.
 */
export function createReferenceImageLoader(dependencies: ReferenceImageDependencies) {
  // The exported singleton is a process-wide resource guard, independent of
  // per-scope worker concurrency. Capacity exhaustion must be rescheduled.
  let activeLoads = 0;
  return async function loadReferenceImage(_scope: AssetScope, source: string, callerSignal?: AbortSignal): Promise<LoadedReferenceImage> {
    if (activeLoads >= 2) throw new ReferenceImageCapacityError();
    activeLoads++;
    let pendingNative: Promise<unknown> | undefined;
    const controller = new AbortController();
    const abortCaller = () => controller.abort(new Error('Reference image download aborted'));
    callerSignal?.addEventListener('abort', abortCaller, { once: true });
    if (callerSignal?.aborted) abortCaller();
    const timer = setTimeout(() => controller.abort(new Error('Reference image download timed out')), DOWNLOAD_MS);
    const signal = controller.signal;
    // Also bounds non-cancellable DNS resolution and native image parsing.
    const bounded = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) { operation.catch(() => {}); reject(signal.reason); return; }
      signal.addEventListener('abort', abort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    try {
      let url = parseUrl(source);
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const literalFamily = isIP(hostname);
        const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await bounded(dependencies.lookup(hostname));
        if (addresses.length === 0) throw new Error('Reference image hostname has no public addresses');
        for (const entry of addresses) {
          assertGlobal(entry.address);
          if (entry.family !== isIP(entry.address)) throw new Error('Reference image DNS address family mismatch');
        }
        const pinned = addresses[0];
        const response = await bounded(new Promise<IncomingMessage>((resolve, reject) => {
          const req = dependencies.request({
            protocol: 'https:', hostname, port: url.port || 443, servername: literalFamily ? '' : hostname,
            method: 'GET', path: `${url.pathname}${url.search}`, agent: false,
            headers: { Accept: 'image/png,image/jpeg,image/webp', 'Accept-Encoding': 'identity' },
            // No second DNS lookup, including when net requests all addresses.
            lookup: (_host, options, callback) => {
              if (typeof options === 'object' && options.all) callback(null, [pinned]);
              else callback(null, pinned.address, pinned.family);
            },
          }, incoming => {
            req.off('error', reject);
            // Keep an error listener until the socket is gone after cancellation.
            req.on('error', () => {});
            const abortResponse = () => incoming.destroy(signal.reason);
            signal.addEventListener('abort', abortResponse, { once: true });
            incoming.once('close', () => { signal.removeEventListener('abort', abort); signal.removeEventListener('abort', abortResponse); });
            incoming.on('error', () => {});
            if (signal.aborted) { incoming.destroy(); reject(signal.reason); }
            else resolve(incoming);
          });
          const abort = () => req.destroy(signal.reason);
          req.once('error', reject);
          req.once('close', () => signal.removeEventListener('abort', abort));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          else req.end();
        }));
        try {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            if (redirects >= MAX_REDIRECTS || !response.headers.location) throw new Error('Reference image redirect limit or missing location');
            url = parseUrl(new URL(response.headers.location, url).href);
            continue;
          }
          if (status !== 200) throw new Error(`Reference image download returned HTTP ${status}`);
          const mimeType = response.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
          if (!mimeType || !mimeFormats[mimeType]) throw new Error('Unsupported reference image media type');
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('Unsupported reference image HTTP content encoding');
          const length = response.headers['content-length'];
          if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new Error('Reference image exceeds 10 MiB');
          let byteLength = 0;
          const chunks: Buffer[] = [];
          const hash = createHash('sha256');
          await bounded((async () => {
            for await (const chunk of response) {
              signal.throwIfAborted();
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              byteLength += bytes.length;
              if (byteLength > MAX_BYTES) throw new Error('Reference image exceeds 10 MiB');
              // Copy so externally reused chunk buffers cannot alter hashed bytes.
              chunks.push(Buffer.from(bytes)); hash.update(bytes);
            }
          })());
          const bytes = Buffer.concat(chunks, byteLength);
          const decoder = sharp(bytes, { limitInputPixels: MAX_PIXELS, sequentialRead: true, failOn: 'warning', animated: true });
          const stopDecoder = () => decoder.destroy();
          signal.addEventListener('abort', stopDecoder, { once: true });
          try {
            const metadata = await bounded(pendingNative = decoder.metadata());
            if (metadata.format !== mimeFormats[mimeType] || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS || (metadata.pages ?? 1) !== 1) {
              throw new Error('Invalid reference image format, dimensions or animation');
            }
            // Metadata alone accepts truncated files. Force decode, without
            // re-encoding or replacing the bytes subsequently uploaded.
            await bounded(pendingNative = decoder.stats());
          } catch {
            signal.throwIfAborted();
            throw new Error('Invalid reference image bytes or pixel dimensions');
          } finally {
            signal.removeEventListener('abort', stopDecoder); decoder.destroy();
          }
          return Object.freeze({ sha256: hash.digest('hex'), get bytesHandle() { return Buffer.from(bytes); }, mimeType: mimeType as LoadedReferenceImage['mimeType'], byteLength });
        } finally { response.destroy(); }
      }
    } finally {
      clearTimeout(timer); callerSignal?.removeEventListener('abort', abortCaller);
      // Native codecs may finish after destroy(). Keep their concurrency slot
      // until completion even when the caller's time budget has expired.
      if (pendingNative) void pendingNative.then(() => { activeLoads--; }, () => { activeLoads--; });
      else activeLoads--;
    }
  };
}

export const loadReferenceImage = createReferenceImageLoader({ lookup: hostname => lookup(hostname, { all: true, verbatim: true }), request });
