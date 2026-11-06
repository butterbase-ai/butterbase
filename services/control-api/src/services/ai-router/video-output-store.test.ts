import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CreateBucketCommand, DeleteBucketCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRetainedObjectClient } from '../s3.js';
import { createRetainedVideoStore, type RetainedVideoObject } from './video-output-store.js';

const endpoint = process.env.VIDEO_OUTPUT_TEST_S3_ENDPOINT;
const credentials = { accessKeyId: 'prepared-output-test', secretAccessKey: 'prepared-output-test-secret' };
const bytes = Buffer.alloc(128, 7); bytes.write('ftypisom', 4);
let directory: string, file: string;
function identity(bucket = 'test-bucket'): RetainedVideoObject {
  const ownerId = randomUUID(), objectId = randomUUID();
  return { appId: 'app-output-test', organizationId: randomUUID(), ownerId, attemptId: randomUUID(), objectId, index: 0,
    bucket, key: `app-output-test/${ownerId}/${objectId}_generated-video-0`, sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), contentType: 'video/mp4' };
}
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'bb-output-store-test-')); file = join(directory, 'video.mp4'); await writeFile(file, bytes); });
afterAll(async () => { if (file) await unlink(file); if (directory) await rmdir(directory); });

describe('retained object SDK dispatch bounds', () => {
  it.each(['HEAD', 'PUT'] as const)('does not retry %s internally and returns a safe transient error', async method => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.method!); request.resume(); response.writeHead(500, { 'content-type': 'application/xml' });
      response.end('<Error><Code>InternalError</Code><Message>private endpoint failure</Message></Error>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const client = createRetainedObjectClient({ endpoint: `http://127.0.0.1:${address.port}`, forcePathStyle: true, credentials, region: 'us-east-1' });
    try {
      const store = createRetainedVideoStore({ client });
      const result = method === 'HEAD' ? store.inspect(identity()) : store.putFile(identity(), file);
      await expect(result).rejects.toMatchObject({ code: 'OUTPUT_STORAGE_TRANSIENT', permanent: false });
      expect(requests.filter(m => m === method)).toHaveLength(1);
    } finally { client.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

describe.skipIf(!endpoint)('retained object IO through real SDK and local S3 emulator', () => {
  let client: S3Client, bucket: string;
  const objects: RetainedVideoObject[] = [];
  beforeAll(async () => {
    const parsed = new URL(endpoint!);
    if (parsed.hostname !== '127.0.0.1' || parsed.port !== '19090') throw new Error('Requires isolated S3 test endpoint');
    client = createRetainedObjectClient({ endpoint, forcePathStyle: true, credentials, region: 'us-east-1' });
    bucket = `prepared-output-${randomUUID()}`;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  });
  afterAll(async () => {
    if (client) {
      try {
        for (const object of objects) await client.send(new (await import('@aws-sdk/client-s3')).DeleteObjectCommand({ Bucket: bucket, Key: object.key }));
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      } finally { client.destroy(); }
    }
  });
  const next = () => { const object = identity(bucket); objects.push(object); return object; };
  it('streams a file, validates matching metadata, adopts the same identity, and retrieves exact bytes', async () => {
    const object = next(), store = createRetainedVideoStore({ client });
    expect(await store.inspect(object)).toBeNull();
    expect(await store.putFile(object, file)).toMatchObject({ adopted: false });
    expect(await store.inspect(object)).toMatchObject({ sizeBytes: bytes.length, contentType: 'video/mp4' });
    expect(await store.putFile(object, file)).toMatchObject({ adopted: true });
    const output = await store.read(object);
    expect(output.statusCode).toBe(200); expect(output.contentLength).toBe(bytes.length);
    expect(Buffer.from(await new Response(output.stream).arrayBuffer())).toEqual(bytes);
    expect(await store.remove(object)).toBe(true); expect(await store.inspect(object)).toBeNull();
  });
  it('supports byte ranges and rejects invalid or unsatisfiable ranges', async () => {
    const object = next(), store = createRetainedVideoStore({ client }); await store.putFile(object, file);
    const range = await store.read(object, { range: 'bytes=0-9' });
    expect(range.statusCode).toBe(206); expect(range.contentRange).toBe('bytes 0-9/128'); expect(range.contentLength).toBe(10);
    expect(Buffer.from(await new Response(range.stream).arrayBuffer())).toEqual(bytes.subarray(0, 10));
    await expect(store.read(object, { range: 'bytes=0-1,4-5' })).rejects.toMatchObject({ statusCode: 416 });
    await expect(store.read(object, { range: 'bytes=999-1000' })).rejects.toMatchObject({ statusCode: 416 });
  });
  it('never overwrites, adopts or deletes an existing foreign object', async () => {
    const object = next(), store = createRetainedVideoStore({ client });
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: object.key, Body: 'foreign bytes', ContentType: 'video/mp4', Metadata: { sha256: object.sha256 } }));
    await expect(store.putFile(object, file)).rejects.toMatchObject({ code: 'OUTPUT_FOREIGN_OBJECT', permanent: true });
    await expect(store.remove(object)).rejects.toMatchObject({ code: 'OUTPUT_FOREIGN_OBJECT' });
    const saved = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }));
    expect(await saved.Body!.transformToString()).toBe('foreign bytes');
  });
  it('rejects oversize, size mismatch, hash mismatch and cross-app keys before a PUT', async () => {
    const object = next(), store = createRetainedVideoStore({ client });
    await expect(createRetainedVideoStore({ client, maxBytes: 16 }).putFile(object, file)).rejects.toMatchObject({ code: 'OUTPUT_INVALID_MEDIA', permanent: true });
    await expect(store.putFile({ ...object, sizeBytes: 127 }, file)).rejects.toMatchObject({ code: 'OUTPUT_INVALID_MEDIA' });
    await expect(store.putFile({ ...object, sha256: 'b'.repeat(64) }, file)).rejects.toMatchObject({ code: 'OUTPUT_INVALID_MEDIA' });
    await expect(store.putFile({ ...object, key: `other-app/${object.ownerId}/${object.objectId}_generated-video-0` }, file)).rejects.toMatchObject({ code: 'OUTPUT_INVALID_IDENTITY' });
    expect(await store.inspect(object)).toBeNull();
  });
  it('cancels an SDK response stream without leaving its body open', async () => {
    const object = next(), store = createRetainedVideoStore({ client }); await store.putFile(object, file);
    const output = await store.read(object); await output.stream.cancel();
    expect(await store.remove(object)).toBe(true);
  });
});
