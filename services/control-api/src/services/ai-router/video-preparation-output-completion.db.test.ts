import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPreparedOutputTestDb } from '../../../test/fixtures/prepared-output-db.js';
import * as outputs from './video-preparation-outputs.js';
import * as preparations from './video-preparations.js';

let fixture: Awaited<ReturnType<typeof createPreparedOutputTestDb>>;
let scope: Awaited<ReturnType<typeof fixture.seed>>;
const measured = { sizeBytes: 128, contentType: 'video/mp4', sha256: 'a'.repeat(64) };

describe.skipIf(!process.env.VIDEO_OUTPUT_TEST_DATABASE_URL)('stored video completion and publication (isolated PostgreSQL)', () => {
  beforeAll(async () => { fixture = await createPreparedOutputTestDb(); });
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => { await fixture.reset(); scope = await fixture.seed(); });
  const allocate = () => outputs.ensurePreparedOutputs(fixture.pool, { attemptId: scope.attempt.id, attemptFence: 1, bucket: 'test-bucket', count: 1, providerCostUsd: 0.2 });
  const complete = (ids: string[]) => preparations.markAttemptTerminal(fixture.pool, scope.attempt.id, 1, { status: 'completed', outputObjectIds: ids, providerCostUsd: 0.2 });
  async function store() {
    const row = (await allocate())![0];
    const claim = (await outputs.claimPreparedOutput(fixture.pool, row.id, { attemptFence: 1, worker: 'copy' }))!;
    await outputs.recordPreparedOutputMeasurement(fixture.pool, row.id, claim.fence, measured);
    await fixture.pool.query('UPDATE ai_video_preparation_outputs SET capacity_reserved=true WHERE id=$1', [row.id]);
    await outputs.markPreparedOutputCopied(fixture.pool, row.id, claim.fence);
    return (await outputs.commitPreparedOutputMetadata(fixture.pool, { attemptId: scope.attempt.id, attemptFence: 1 }))!;
  }
  async function acknowledge(status = 'settled', chargedUsd = 0.24) {
    const tx = await fixture.pool.connect();
    try { await tx.query('BEGIN'); await preparations.acknowledgeAttemptSettlement(tx, scope.attempt.id, { reservationId: scope.attempt.reservation_id, status, chargedUsd }); await tx.query('COMMIT'); }
    catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  }

  it('refuses completion from allocated IDs before retained bytes and metadata exist', async () => {
    const row = (await allocate())![0];
    await expect(complete([row.object_id])).rejects.toThrow(/stored|retained|metadata/i);
    expect((await preparations.getAttempt(fixture.pool, scope.attempt.id))?.submission_state).toBe('accepted');
  });
  it('publishes ordered stored IDs atomically only after an acknowledged settled receipt', async () => {
    const ids = await store();
    expect(await complete(ids)).toBe(true);
    const parent = (await preparations.claimPreparation(fixture.pool, scope.job.id, 'finish', 60_000))!;
    expect(await outputs.finishStoredPreparation(fixture.pool, parent.id, parent.fence)).toBe(false);
    expect((await fixture.pool.query('SELECT published_at FROM storage_objects')).rows[0].published_at).toBeNull();
    await acknowledge();
    expect(await outputs.finishStoredPreparation(fixture.pool, parent.id, parent.fence)).toBe(true);
    expect(await preparations.getPreparation(fixture.pool, parent.id)).toMatchObject({ status: 'completed', terminal_outcome: { status: 'completed', outputObjectIds: ids, providerCostUsd: 0.2 } });
    expect((await fixture.pool.query('SELECT published_at FROM storage_objects')).rows[0].published_at).toBeInstanceOf(Date);
    expect(await outputs.finishStoredPreparation(fixture.pool, parent.id, parent.fence)).toBe(false);
  });
  it('never publishes an uncharged completed delivery after a reclaimed reservation', async () => {
    const ids = await store();
    await complete(ids);
    await acknowledge('reclaimed', 0);
    const parent = (await preparations.claimPreparation(fixture.pool, scope.job.id, 'finish', 60_000))!;
    expect(await outputs.finishStoredPreparation(fixture.pool, parent.id, parent.fence)).toBe(true);
    expect(await preparations.getPreparation(fixture.pool, parent.id)).toMatchObject({ status: 'failed', terminal_outcome: { status: 'failed', error: 'reservation_unavailable', providerStatus: 'completed', providerCostUsd: 0.2 } });
    expect((await fixture.pool.query('SELECT count(*)::int AS count FROM storage_objects')).rows[0].count).toBe(0);
    expect((await outputs.listPreparedOutputs(fixture.pool, scope.attempt.id))[0].state).toBe('cleanup_pending');
  });
  it('does not accept a late completion after deletion or recreate the output', async () => {
    const ids = await store();
    await fixture.pool.query('DELETE FROM apps WHERE id=$1', [scope.app]);
    expect(await complete(ids)).toBe(false);
    expect(await preparations.markAttemptTerminal(fixture.pool, scope.attempt.id, 1, { status: 'failed', providerStatus: 'completed', providerCostUsd: 0.2, error: 'output_cancelled' })).toBe(true);
    expect((await fixture.pool.query('SELECT count(*)::int AS count FROM storage_objects')).rows[0].count).toBe(0);
  });
  it('rejects publication by a premature storage update', async () => {
    await store();
    await expect(fixture.pool.query('UPDATE storage_objects SET published_at=now()')).rejects.toThrow(/settle|publication|completed/i);
  });
  it('does not deadlock with app teardown when storing an attempt outcome', async () => {
    const ids = await store();
    const tx = await fixture.pool.connect();
    try {
      await tx.query('BEGIN'); await tx.query('SELECT id FROM apps WHERE id=$1 FOR UPDATE', [scope.app]);
      expect(await complete(ids)).toBe(false);
      await tx.query('ROLLBACK');
    } finally { tx.release(); }
    expect(await complete(ids)).toBe(true);
  });
  it('preserves historical URL-based attempt completions', async () => {
    expect(await preparations.markAttemptTerminal(fixture.pool, scope.attempt.id, 1, { status: 'completed', output: ['https://media.example/legacy.mp4'] })).toBe(true);
  });
  it('refuses a retained-output completion after the app owner changes', async () => {
    const ids = await store();
    await fixture.pool.query('UPDATE apps SET owner_id=gen_random_uuid() WHERE id=$1', [scope.app]);
    expect(await complete(ids)).toBe(false);
  });
});
