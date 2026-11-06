import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPreparedOutputTestDb } from '../../../test/fixtures/prepared-output-db.js';
import * as outputs from './video-preparation-outputs.js';

describe.skipIf(!process.env.VIDEO_OUTPUT_TEST_DATABASE_URL)('private output source handoff (isolated PostgreSQL)', () => {
  let db: Awaited<ReturnType<typeof createPreparedOutputTestDb>>, scope: Awaited<ReturnType<typeof db.seed>>;
  beforeAll(async () => { db = await createPreparedOutputTestDb(); });
  beforeEach(async () => { await db.reset(); scope = await db.seed(); });
  afterAll(async () => { await db?.close(); });
  const ensure = (sourceHandles: string[], fence = scope.attempt.fence) => outputs.ensurePreparedOutputs(db.pool, {
    attemptId: scope.attempt.id, attemptFence: fence, bucket: 'test-bucket', count: sourceHandles.length, sourceHandles,
  });
  it('persists bounded private handles separately from public outcomes and refreshes only under current authority', async () => {
    const first = await ensure(['opaque-source-1', 'opaque-source-2']);
    expect(first?.map(row => row.source_handle)).toEqual(['opaque-source-1', 'opaque-source-2']);
    expect(await ensure(['stale', 'stale'], 99)).toBeNull();
    const refreshed = await ensure(['fresh-source-1', 'fresh-source-2']);
    expect(refreshed?.map(row => row.object_id)).toEqual(first?.map(row => row.object_id));
    expect(refreshed?.map(row => row.source_handle)).toEqual(['fresh-source-1', 'fresh-source-2']);
    await expect(ensure(['x'.repeat(8193)])).rejects.toMatchObject({ code: 'OUTPUT_INVALID_SOURCE' });
    const job = (await db.pool.query('SELECT terminal_outcome FROM ai_video_preparations WHERE id=$1', [scope.job.id])).rows[0];
    expect(job.terminal_outcome).toBeNull();
  });
  it('erases source evidence when bytes are retained and cannot restore it to copied outputs', async () => {
    const row = (await ensure(['private-url']))![0];
    const claim = (await outputs.claimPreparedOutput(db.pool, row.id, { worker: 'copy', attemptFence: scope.attempt.fence }))!;
    await outputs.recordPreparedOutputMeasurement(db.pool, row.id, claim.fence, { sizeBytes: 128, sha256: 'a'.repeat(64), contentType: 'video/mp4' });
    await db.pool.query('UPDATE ai_video_preparation_outputs SET capacity_reserved=true WHERE id=$1', [row.id]);
    expect(await outputs.markPreparedOutputCopied(db.pool, row.id, claim.fence)).toBe(true);
    expect((await ensure(['do-not-restore']))![0].source_handle).toBeNull();
  });
  it('erases private handles on app deletion and durable cleanup retirement', async () => {
    const first = (await ensure(['private-url']))![0];
    await db.pool.query('DELETE FROM apps WHERE id=$1', [scope.app]);
    expect((await outputs.listPreparedOutputs(db.pool, scope.attempt.id))[0].source_handle).toBeNull();
    scope = await db.seed(null, '-second');
    const second = (await ensure(['private-url']))![0];
    await outputs.requestPreparedOutputCleanup(db.pool, { attemptId: scope.attempt.id, attemptFence: scope.attempt.fence, errorCode: 'invalid_output' });
    expect((await outputs.listPreparedOutputs(db.pool, scope.attempt.id))[0]).toMatchObject({ id: second.id, source_handle: null, state: 'cleanup_pending' });
    expect(second.id).not.toBe(first.id);
  });
});
