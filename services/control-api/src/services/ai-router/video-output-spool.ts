import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, unlink, rmdir, mkdir, lstat, opendir } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PREPARED_OUTPUT_MAX_BYTES } from './video-preparation-outputs.js';
import { VideoOutputStorageError } from './video-output-store.js';

const spoolRoot = join(tmpdir(), 'butterbase-prepared-video');
const host = createHash('sha256').update(hostname()).digest('hex').slice(0, 12);
const processState = globalThis as typeof globalThis & { __butterbaseVideoSpoolIncarnation?: string };
const incarnation = processState.__butterbaseVideoSpoolIncarnation ??= randomBytes(16).toString('hex');
const prefix = `bb-video-output-${host}-${process.pid}-${incarnation}-`;

/** Delete only recognized files belonging to a provably dead local process.
 * Ambiguous foreign PID reuse or an inaccessible process keeps its files. */
export async function reapAbandonedVideoSpools(base = spoolRoot): Promise<void> {
  const root = resolve(base);
  let entries;
  try {
    const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    entries = await opendir(root);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let inspected = 0;
  for await (const entry of entries) {
    if (++inspected > 64) break;
    const match = /^bb-video-output-([a-f0-9]{12})-([1-9][0-9]{0,9})-([a-f0-9]{32})-[A-Za-z0-9]{6}$/.exec(entry.name);
    if (!match || match[1] !== host || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const pid = Number(match[2]);
    if (pid === process.pid) { if (match[3] === incarnation) continue; }
    else { try { process.kill(pid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; } }
    const directory = resolve(root, entry.name); if (dirname(directory) !== root) continue;
    try {
      const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      let hasOutput = false, unknown = false;
      for await (const child of await opendir(directory)) {
        if (child.name !== 'output' || hasOutput) { unknown = true; break; }
        hasOutput = true;
      }
      if (unknown) continue;
      if (hasOutput) {
        const file = join(directory, 'output'); const fileStat = await lstat(file);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue;
        await unlink(file);
      }
      await rmdir(directory);
    } catch (error) { if (!['ENOENT','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
}

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
    const base = options.directory ?? spoolRoot;
    await mkdir(base, { recursive: true, mode: 0o700 });
    const baseStat = await lstat(base);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw unavailable();
    await reapAbandonedVideoSpools(base);
    directory = await mkdtemp(join(base, prefix));
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
