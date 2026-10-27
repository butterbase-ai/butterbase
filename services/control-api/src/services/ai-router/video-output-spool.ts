import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PREPARED_OUTPUT_MAX_BYTES } from './video-preparation-outputs.js';
import { VideoOutputStorageError } from './video-output-store.js';

/** Spool under backpressure, bounded by bytes and time, with no whole-video buffer. */
export async function spoolVideoOutput(source: { stream: ReadableStream<Uint8Array>; contentType: string }, options: {
  maxBytes: number; timeoutMs?: number; signal?: AbortSignal; directory?: string;
}) {
  const invalid = () => new VideoOutputStorageError('OUTPUT_INVALID_MEDIA', true);
  const unavailable = () => new VideoOutputStorageError('OUTPUT_SOURCE_UNAVAILABLE', false);
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > PREPARED_OUTPUT_MAX_BYTES
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    await source.stream.cancel().catch(() => {}); throw invalid();
  }
  const mime = source.contentType.split(';')[0].trim().toLowerCase();
  if (!['video/mp4', 'video/webm', 'application/octet-stream'].includes(mime)) {
    await source.stream.cancel().catch(() => {}); throw invalid();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let directory: string | undefined, filePath: string | undefined, disposed = false;
  const dispose = async () => {
    if (disposed) return;
    if (filePath) await unlink(filePath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    if (directory) await rmdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    disposed = true;
  };
  try {
    if (signal.aborted) { await source.stream.cancel().catch(() => {}); throw unavailable(); }
    directory = await mkdtemp(join(options.directory ?? tmpdir(), 'bb-video-output-'));
    filePath = join(directory, 'output');
    let sizeBytes = 0; const hash = createHash('sha256'); let header = Buffer.alloc(0);
    const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > options.maxBytes) { callback(invalid()); return; }
      hash.update(chunk);
      if (header.length < 64) header = Buffer.concat([header, chunk.subarray(0, 64 - header.length)]);
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(source.stream as Parameters<typeof Readable.fromWeb>[0]), measure,
      createWriteStream(filePath, { flags: 'wx', mode: 0o600 }), { signal });
    let contentType: 'video/mp4' | 'video/webm';
    if (sizeBytes >= 12 && header.toString('ascii', 4, 8) === 'ftyp'
      && header.readUInt32BE(0) >= 12 && header.readUInt32BE(0) <= sizeBytes) contentType = 'video/mp4';
    else if (sizeBytes >= 8 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) contentType = 'video/webm';
    else throw invalid();
    if (mime !== 'application/octet-stream' && mime !== contentType) throw invalid();
    return { filePath, sizeBytes, sha256: hash.digest('hex'), contentType, dispose };
  } catch (error) {
    if (!source.stream.locked) await source.stream.cancel().catch(() => {});
    await dispose();
    throw error instanceof VideoOutputStorageError ? error : unavailable();
  } finally { clearTimeout(timer); }
}
