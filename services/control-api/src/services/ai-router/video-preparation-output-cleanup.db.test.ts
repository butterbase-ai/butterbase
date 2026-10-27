import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPreparedOutputTestDb } from '../../../test/fixtures/prepared-output-db.js';
import * as outputs from './video-preparation-outputs.js';

let fixture: Awaited<ReturnType<typeof createPreparedOutputTestDb>>;
let scope: Awaited<ReturnType<typeof fixture.seed>>;
const measured = { sizeBytes: 128, sha256: 'a'.repeat(64), contentType: 'video/mp4' };
async function claimCopy() {
  const row = (await outputs.ensurePreparedOutputs(fixture.pool, { attemptId: scope.attempt.id, attemptFence: 1, bucket: 'test-bucket', count: 1 }))![0];
  return (await outputs.claimPreparedOutput(fixture.pool, row.id, { attemptFence: 1, worker: 'copy' }))!;
}
const retire = () => outputs.requestPreparedOutputCleanup(fixture.pool, { attemptId: scope.attempt.id, attemptFence: 1, errorCode: 'output_delivery_failed' });

describe.skipIf(!process.env.VIDEO_OUTPUT_TEST_DATABASE_URL)('prepared output retry and cleanup (isolated PostgreSQL)', () => {
  beforeAll(async () => { fixture = await createPreparedOutputTestDb(); });
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => { await fixture.reset(); scope = await fixture.seed(); });

  it('defers a copy at its same identity and retains reserved bytes after an uncertain PUT', async () => {
    const row = await claimCopy();
    await outputs.recordPreparedOutputMeasurement(fixture.pool, row.id, row.fence, measured);
    await fixture.pool.query('UPDATE ai_video_preparation_outputs SET capacity_reserved=true WHERE id=$1', [row.id]);
    expect(await outputs.markPreparedOutputUploadStarted(fixture.pool, row.id, row.fence)).toBe(true);
    const next = new Date(Date.now() + 10_000);
    expect(await outputs.deferPreparedOutput(fixture.pool, row.id, row.fence, 'storage_transport', next)).toBe(true);
    const deferred = (await outputs.listPreparedOutputs(fixture.pool, scope.attempt.id))[0];
    expect(deferred).toMatchObject({ state: 'pending', object_id: row.object_id, object_key: row.object_key, capacity_reserved: true, sha256: measured.sha256, lease_owner: null, next_action_at: next });
    expect(deferred.cleanup_probe_until).toBeInstanceOf(Date);
    expect(await outputs.claimPreparedOutput(fixture.pool, row.id, { attemptFence: 1, worker: 'early' })).toBeNull();
  });
  it('never authorizes a PUT without measured bytes and reserved capacity', async () => {
    const row = await claimCopy();
    expect(await outputs.markPreparedOutputUploadStarted(fixture.pool, row.id, row.fence)).toBe(false);
    await outputs.recordPreparedOutputMeasurement(fixture.pool, row.id, row.fence, measured);
    expect(await outputs.markPreparedOutputUploadStarted(fixture.pool, row.id, row.fence)).toBe(false);
    await fixture.pool.query('UPDATE ai_video_preparation_outputs SET capacity_reserved=true WHERE id=$1', [row.id]);
    expect(await outputs.markPreparedOutputUploadStarted(fixture.pool, row.id, row.fence)).toBe(true);
    expect(await outputs.markPreparedOutputUploadStarted(fixture.pool, row.id, row.fence)).toBe(false);
  });
  it('keeps the late-write probe when a new worker adopts bytes from an expired PUT claim', async () => {
    const row = await claimCopy();
    await outputs.recordPreparedOutputMeasurement(fixture.pool, row.id, row.fence, measured);
    await fixture.pool.query('UPDATE ai_video_preparation_outputs SET capacity_reserved=true WHERE id=$1', [row.id]);
    await outputs.markPreparedOutputUploadStarted(fixture.pool, row.id, row.fence);
    await fixture.pool.query("UPDATE ai_video_preparation_outputs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [row.id]);
    const adopted = (await outputs.claimPreparedOutput(fixture.pool, row.id, { attemptFence: 1, worker: 'adopt' }))!;
    expect(adopted.uncertain_put).toBe(true);
    await outputs.markPreparedOutputCopied(fixture.pool, row.id, adopted.fence);
    const copied = (await outputs.listPreparedOutputs(fixture.pool, scope.attempt.id))[0];
    expect(copied.state).toBe('copied');
    expect(copied.cleanup_probe_until!.getTime()).toBeGreaterThan(Date.now());
  });
  it('does not retain a late-PUT probe when no upload was dispatched', async () => {
    const row = await claimCopy();
    await fixture.pool.query('DELETE FROM apps WHERE id=$1', [scope.app]);
    expect((await outputs.listPreparedOutputs(fixture.pool, scope.attempt.id))[0]).toMatchObject({ id: row.id, state: 'cleanup_pending', cleanup_probe_until: null });
  });
  it('retains uncertain PUT cleanup after app deletion, including orphan claims', async () => {
    const row = await claimCopy();
    await outputs.recordPreparedOutputMeasurement(fixture.pool, row.id, row.fence, measured);
    await fixture.pool.query('UPDATE ai_video_preparation_outputs SET capacity_reserved=true WHERE id=$1', [row.id]);
    await outputs.markPreparedOutputUploadStarted(fixture.pool, row.id, row.fence);
    await fixture.pool.query('DELETE FROM apps WHERE id=$1', [scope.app]);
    expect(await outputs.claimPreparedOutputCleanup(fixture.pool, row.id, { worker: 'early' })).toBeNull();
    await fixture.pool.query("UPDATE ai_video_preparation_outputs SET cleanup_not_before=now()-interval '1 second' WHERE id=$1", [row.id]);
    const cleanup = (await outputs.claimPreparedOutputCleanup(fixture.pool, row.id, { worker: 'cleanup' }))!;
    expect(cleanup).toMatchObject({ state: 'cleanup_pending', bucket: row.bucket, object_key: row.object_key });
    expect(await outputs.finishPreparedOutputCleanup(fixture.pool, row.id, cleanup.fence, true, new Date(Date.now() + 1000))).toBe(true);
    const deleted = (await outputs.listPreparedOutputs(fixture.pool, scope.attempt.id))[0];
    expect(deleted).toMatchObject({ state: 'deleted', capacity_reserved: false, object_key: row.object_key });
    expect(deleted.cleanup_probe_until!.getTime()).toBeGreaterThan(Date.now());
  });
  it('has one cleanup winner and fences stale cleanup acknowledgements', async () => {
    const row = await claimCopy(); await retire();
    const first = await Promise.all([outputs.claimPreparedOutputCleanup(fixture.pool, row.id, { worker: 'one' }), outputs.claimPreparedOutputCleanup(fixture.pool, row.id, { worker: 'two' })]);
    expect(first.filter(Boolean)).toHaveLength(1);
    const winner = first.find(Boolean)!;
    await fixture.pool.query("UPDATE ai_video_preparation_outputs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [row.id]);
    const next = (await outputs.claimPreparedOutputCleanup(fixture.pool, row.id, { worker: 'new' }))!;
    expect(await outputs.finishPreparedOutputCleanup(fixture.pool, row.id, winner.fence, true, new Date())).toBe(false);
    expect(await outputs.finishPreparedOutputCleanup(fixture.pool, row.id, next.fence, false, new Date(Date.now() + 1000))).toBe(true);
    expect((await outputs.listPreparedOutputs(fixture.pool, scope.attempt.id))[0]).toMatchObject({ state: 'cleanup_pending', object_key: row.object_key, lease_owner: null });
  });
  it('does not grant cleanup under app lock contention or on archived work', async () => {
    const row = await claimCopy(); await retire();
    const tx = await fixture.pool.connect();
    try { await tx.query('BEGIN'); await tx.query('SELECT id FROM apps WHERE id=$1 FOR UPDATE', [scope.app]);
      expect(await outputs.claimPreparedOutputCleanup(fixture.pool, row.id, { worker: 'blocked' })).toBeNull();
      await tx.query('ROLLBACK');
    } finally { tx.release(); }
    await fixture.pool.query('UPDATE ai_video_preparation_outputs SET archived_after_move=$2 WHERE id=$1', [row.id, randomUUID()]);
    expect(await outputs.claimPreparedOutputCleanup(fixture.pool, row.id, { worker: 'archived' })).toBeNull();
  });
  it('rearms a late PUT cleanup only on an already tombstoned output', async () => {
    const row = await claimCopy();
    expect(await outputs.rearmLatePreparedOutputCleanup(fixture.pool, row.id)).toBe(false);
    await retire();
    const cleanup = (await outputs.claimPreparedOutputCleanup(fixture.pool, row.id, { worker: 'cleanup' }))!;
    await outputs.finishPreparedOutputCleanup(fixture.pool, row.id, cleanup.fence, true, new Date());
    expect(await outputs.rearmLatePreparedOutputCleanup(fixture.pool, row.id)).toBe(true);
    expect((await outputs.listPreparedOutputs(fixture.pool, scope.attempt.id))[0].state).toBe('cleanup_pending');
    expect(await outputs.markPreparedOutputCopied(fixture.pool, row.id, row.fence)).toBe(false);
  });
});
