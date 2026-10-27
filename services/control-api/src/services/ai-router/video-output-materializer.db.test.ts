import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPreparedOutputTestDb } from '../../../test/fixtures/prepared-output-db.js';
import { createRetainedObjectClient } from '../s3.js';
import * as outputs from './video-preparation-outputs.js';
import { createRetainedVideoStore, VideoOutputStorageError } from './video-output-store.js';
import { materializePreparedVideoOutputs } from './video-output-materializer.js';

const endpoint = process.env.VIDEO_OUTPUT_TEST_S3_ENDPOINT;
describe.skipIf(!endpoint || !process.env.VIDEO_OUTPUT_TEST_DATABASE_URL)('retained output materializer with real PostgreSQL and S3 SDK', () => {
  let db: Awaited<ReturnType<typeof createPreparedOutputTestDb>>, scope: Awaited<ReturnType<typeof db.seed>>;
  let client: S3Client, bucket: string, fetches = 0;
  const bytes = Buffer.alloc(128, 7); bytes.writeUInt32BE(24, 0); bytes.write('ftypisom', 4);
  beforeAll(async () => {
    const parsed = new URL(endpoint!); if (parsed.hostname !== '127.0.0.1' || parsed.port !== '19090') throw new Error('Requires isolated S3 fixture');
    db = await createPreparedOutputTestDb(); client = createRetainedObjectClient({ endpoint, forcePathStyle: true, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
    bucket = `output-materializer-${randomUUID()}`; await client.send(new CreateBucketCommand({ Bucket: bucket }));
  });
  beforeEach(async () => { await db.reset(); scope = await db.seed(); fetches = 0; });
  afterAll(async () => {
    if (client) { try {
      const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
      if (objects.Contents?.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.Contents.map(o => ({ Key: o.Key! })) } }));
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    } finally { client.destroy(); } }
    await db?.close();
  });
  const allocate = (count = 1) => outputs.ensurePreparedOutputs(db.pool, { attemptId: scope.attempt.id, attemptFence: 1, bucket, count,
    providerCostUsd: 0.2, sourceHandles: Array.from({ length: count }, (_, i) => `source-${i}`) });
  const options = () => ({ pool: db.pool, attemptId: scope.attempt.id, attemptFence: 1,
    authorize: async () => {}, createStore: (signal: AbortSignal) => createRetainedVideoStore({ client, signal }),
    fetchSource: async () => { fetches++; return { contentType: 'video/mp4', stream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) }; },
  });
  it('copies every output before returning ordered stable IDs; provider reads can then be disabled', async () => {
    const rows = (await allocate(2))!;
    expect(await materializePreparedVideoOutputs(options())).toMatchObject({ status: 'pending' });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM storage_objects')).rows[0].n).toBe(0);
    expect(await materializePreparedVideoOutputs(options())).toMatchObject({ status: 'ready', outputObjectIds: rows.map(r => r.object_id), providerCostUsd: 0.2 });
    expect(fetches).toBe(2);
    const again = await materializePreparedVideoOutputs({ ...options(), fetchSource: async () => { throw new Error('provider disabled'); } });
    expect(again).toMatchObject({ status: 'ready', outputObjectIds: rows.map(r => r.object_id) });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM storage_objects WHERE published_at IS NULL')).rows[0].n).toBe(2);
    const stored = (await outputs.listPreparedOutputs(db.pool, scope.attempt.id))[0];
    const { retainedVideoIdentity } = await import('./video-output-materializer.js');
    const read = await createRetainedVideoStore({ client }).read(retainedVideoIdentity(stored));
    expect(Buffer.from(await new Response(read.stream).arrayBuffer())).toEqual(bytes);
  });
  it('adopts a PUT whose response was lost without downloading again or allocating another object', async () => {
    const row = (await allocate())![0];
    const opts = options();
    const result = await materializePreparedVideoOutputs({ ...opts, createStore: signal => {
      const store = opts.createStore(signal); return { ...store, putFile: async (...args: Parameters<typeof store.putFile>) => {
        await store.putFile(...args); throw new VideoOutputStorageError('OUTPUT_STORAGE_TRANSIENT', false);
      } };
    } });
    expect(result).toMatchObject({ status: 'pending' });
    const uncertain = (await outputs.listPreparedOutputs(db.pool, scope.attempt.id))[0];
    expect(uncertain).toMatchObject({ object_id: row.object_id, state: 'pending', uncertain_put: true });
    await db.pool.query('UPDATE ai_video_preparation_outputs SET next_action_at=now() WHERE id=$1', [row.id]);
    expect(await materializePreparedVideoOutputs({ ...opts, fetchSource: async () => { throw new Error('must adopt'); } })).toMatchObject({ status: 'ready', outputObjectIds: [row.object_id] });
    expect(fetches).toBe(1);
  });
  it('retains provider expense but retires output on permanent invalid media or quota', async () => {
    await allocate();
    const failed = await materializePreparedVideoOutputs({ ...options(), fetchSource: async () => ({ contentType: 'video/mp4', stream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('<html>private failure</html>')); c.close(); } }) }) });
    expect(failed).toMatchObject({ status: 'failed', providerCostUsd: 0.2, error: 'output_invalid_media' });
    expect((await outputs.listPreparedOutputs(db.pool, scope.attempt.id))[0]).toMatchObject({ state: 'cleanup_pending', source_handle: null });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM storage_objects')).rows[0].n).toBe(0);
  });
  it('requests GET-only source refresh after a temporary download failure', async () => {
    await allocate();
    const result = await materializePreparedVideoOutputs({ ...options(), fetchSource: async () => { throw new Error('private expiring URL'); } });
    expect(result).toMatchObject({ status: 'pending', refreshSources: true });
    expect((await outputs.listPreparedOutputs(db.pool, scope.attempt.id))[0]).toMatchObject({ state: 'pending', source_handle: null });
  });
  it('never publishes after deletion during PUT and retains a cleanup obligation', async () => {
    await allocate(); const opts = options();
    const result = await materializePreparedVideoOutputs({ ...opts, createStore: signal => {
      const store = opts.createStore(signal); return { ...store, putFile: async (...args: Parameters<typeof store.putFile>) => {
        const result = await store.putFile(...args); await db.pool.query('DELETE FROM apps WHERE id=$1', [scope.app]); return result;
      } };
    } });
    expect(result.status).not.toBe('ready');
    expect((await outputs.listPreparedOutputs(db.pool, scope.attempt.id))[0]).toMatchObject({ state: 'cleanup_pending' });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM storage_objects')).rows[0].n).toBe(0);
  });
});
