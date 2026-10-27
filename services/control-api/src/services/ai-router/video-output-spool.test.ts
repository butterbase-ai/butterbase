import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spoolVideoOutput } from './video-output-spool.js';

const mp4 = Buffer.alloc(128, 7); mp4.writeUInt32BE(24, 0); mp4.write('ftypisom', 4);
let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'bb-video-spool-test-')); });
afterAll(async () => { expect(await readdir(root)).toEqual([]); await rmdir(root); });
const source = (bytes: Uint8Array, type = 'video/mp4') => ({ contentType: type, stream: new ReadableStream<Uint8Array>({
  start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3)); controller.close(); },
}) });
describe('bounded provider video spool', () => {
  it('writes chunked bytes to a private temporary file and measures the exact hash and type', async () => {
    const output = await spoolVideoOutput(source(mp4), { maxBytes: 1024, directory: root });
    try {
      expect(output.sizeBytes).toBe(mp4.length); expect(output.sha256).toBe(createHash('sha256').update(mp4).digest('hex'));
      expect(output.contentType).toBe('video/mp4'); expect(await readFile(output.filePath)).toEqual(mp4);
      expect(dirname(dirname(output.filePath))).toBe(root);
    } finally { await output.dispose(); await output.dispose(); }
    expect(await readdir(root)).toEqual([]);
  });
  it('detects WebM from octet-stream without trusting the upstream MIME label', async () => {
    const bytes = Buffer.alloc(48); bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
    const output = await spoolVideoOutput(source(bytes, 'application/octet-stream'), { maxBytes: 1024, directory: root });
    try { expect(output.contentType).toBe('video/webm'); } finally { await output.dispose(); }
  });
  it.each([
    ['oversize', mp4, 'video/mp4', 100],
    ['wrong MIME', mp4, 'image/png', 1024],
    ['false MIME', mp4, 'video/webm', 1024],
    ['invalid signature', Buffer.from('<html>provider private error</html>'), 'video/mp4', 1024],
    ['empty', Buffer.alloc(0), 'video/mp4', 1024],
  ] as const)('rejects %s and removes partial files', async (_name, bytes, type, limit) => {
    await expect(spoolVideoOutput(source(bytes, type), { maxBytes: limit, directory: root })).rejects.toMatchObject({ code: 'OUTPUT_INVALID_MEDIA', permanent: true });
    expect(await readdir(root)).toEqual([]);
  });
  it('aborts a stalled stream within the deadline and cancels the upstream body', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(mp4.subarray(0, 8)); }, cancel() { cancelled = true; } });
    await expect(spoolVideoOutput({ stream, contentType: 'video/mp4' }, { maxBytes: 1024, timeoutMs: 25, directory: root })).rejects.toMatchObject({ code: 'OUTPUT_SOURCE_UNAVAILABLE', permanent: false });
    expect(cancelled).toBe(true); expect(await readdir(root)).toEqual([]);
  });
  it('scrubs source errors and cancels on external lease cancellation', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error('secret provider URL')); } });
    await expect(spoolVideoOutput({ stream, contentType: 'video/mp4' }, { maxBytes: 1024, directory: root })).rejects.toMatchObject({ message: 'OUTPUT_SOURCE_UNAVAILABLE', permanent: false });
    const controller = new AbortController(); controller.abort();
    await expect(spoolVideoOutput(source(mp4), { maxBytes: 1024, directory: root, signal: controller.signal })).rejects.toMatchObject({ code: 'OUTPUT_SOURCE_UNAVAILABLE' });
    expect(await readdir(root)).toEqual([]);
  });
});
