import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rmdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spoolVideoOutput, reapAbandonedVideoSpools } from './video-output-spool.js';

const mp4 = Buffer.alloc(128, 7); mp4.writeUInt32BE(24, 0); mp4.write('ftypisom', 4);
let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'bb-video-spool-test-')); });
afterAll(async () => { expect(await readdir(root)).toEqual([]); await rmdir(root); });
const source = (bytes: Uint8Array, type = 'video/mp4') => ({ contentType: type, stream: new ReadableStream<Uint8Array>({
  start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3)); controller.close(); },
}) });
describe('bounded provider video spool', () => {
  it('reclaims an earlier incarnation of the same PID while preserving current files', async () => {
    const live=await spoolVideoOutput(source(mp4),{maxBytes:1024,directory:root});
    const oldName=basename(dirname(live.filePath)).replace(/-[a-f0-9]{32}-/,`-${'0'.repeat(32)}-`);
    const oldDirectory=join(root,oldName);await mkdir(oldDirectory);await writeFile(join(oldDirectory,'output'),mp4);
    try {await reapAbandonedVideoSpools(root);expect(await readdir(root)).toEqual([basename(dirname(live.filePath))]);expect(await readFile(live.filePath)).toEqual(mp4);}
    finally{await live.dispose();}
  });
  it('preserves a live process spool and reclaims it after that process crashes', async () => {
    const code = `const {spoolVideoOutput}=await import(process.argv[1]);
      const b=Buffer.alloc(128,7);b.writeUInt32BE(24);b.write('ftypisom',4);
      const out=await spoolVideoOutput({contentType:'video/mp4',stream:new ReadableStream({start(c){c.enqueue(b);c.close();}})},{maxBytes:1024,directory:process.argv[2]});
      process.stdout.write(out.filePath+'\\n');setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code,new URL('./video-output-spool.ts',import.meta.url).href,root],{stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
    try {
      const path=await new Promise<string>((resolve,reject)=>{let data='';child.stdout.on('data',chunk=>{data+=chunk;if(data.includes('\n'))resolve(data.trim());});child.once('exit',()=>reject(Error(stderr||'Child exited before spool')));});
      await reapAbandonedVideoSpools(root);expect(await readFile(path)).toEqual(mp4);
      const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;
      await reapAbandonedVideoSpools(root);expect(await readdir(root)).toEqual([]);
    } finally { if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;} }
  },15000);
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
