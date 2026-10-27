import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPreparedOutputTestDb } from '../../test/prepared-output-db.js';
import * as outputs from './video-preparation-outputs.js';

const dbUrl = process.env.VIDEO_OUTPUT_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPreparedOutputTestDb>>;
let scope: Awaited<ReturnType<typeof fixture.seed>>;
const measurement = { sizeBytes: 128, sha256: 'a'.repeat(64), contentType: 'video/mp4' };
const ensure = (count = 1) => outputs.ensurePreparedOutputs(fixture.pool, { attemptId: scope.attempt.id, attemptFence: scope.attempt.fence, bucket: 'test-bucket', count, providerCostUsd: 0.2 });
const claimOutput = (id: string, worker: string) => outputs.claimPreparedOutput(fixture.pool, id, { attemptFence: scope.attempt.fence, worker });

describe.skipIf(!dbUrl)('prepared output repository (isolated PostgreSQL)', () => {
  beforeAll(async () => { fixture = await createPreparedOutputTestDb(); });
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => { await fixture.reset(); scope = await fixture.seed(); });

  it('allocates once across concurrent workers, preserving ordered output IDs and scoped valid keys', async () => {
    const [first, second] = await Promise.all([ensure(2), ensure(2)]);
    expect(first).toHaveLength(2);
    expect(second?.map(o => o.object_id)).toEqual(first?.map(o => o.object_id));
    expect(first!.map(o => o.output_index)).toEqual([0, 1]);
    for (const row of first!) {
      expect(row).toMatchObject({ app_id: scope.app, organization_id: scope.org, end_user_sub: 'fictional-subject', state: 'pending' });
      expect(row.object_key).toBe(`${scope.app}/${scope.owner}/${row.object_id}_generated-video-${row.output_index}`);
    }
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM ai_video_preparation_outputs')).rows[0].n).toBe(2);
    await expect(ensure(1)).rejects.toThrow(/identity|count/i);
  });
  it('does not allocate with a stale attempt fence, expired authority, or migration in progress', async () => {
    const args = { attemptId: scope.attempt.id, attemptFence: 99, bucket: 'test-bucket', count: 1 };
    expect(await outputs.ensurePreparedOutputs(fixture.pool, args)).toBeNull();
    await fixture.pool.query("UPDATE ai_video_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [scope.attempt.id]);
    expect(await ensure()).toBeNull();
    await fixture.pool.query("UPDATE ai_video_attempts SET lease_expires_at=now()+interval '60 seconds' WHERE id=$1", [scope.attempt.id]);
    await fixture.pool.query("UPDATE apps SET provisioning_status='migration_target_reserved' WHERE id=$1", [scope.app]);
    expect(await ensure()).toBeNull();
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM ai_video_preparation_outputs')).rows[0].n).toBe(0);
  });
  it('has one claim winner and a bounded regional copy capacity across connections', async () => {
    const rows = (await ensure(3))!;
    const races = await Promise.all([claimOutput(rows[0].id, 'one'), claimOutput(rows[0].id, 'two')]);
    expect(races.filter(Boolean)).toHaveLength(1);
    expect(await claimOutput(rows[1].id, 'three')).not.toBeNull();
    expect(await claimOutput(rows[2].id, 'four')).toBeNull();
  });
  it('fences stale measurements and never changes bytes after first capture', async () => {
    const row = (await ensure())![0];
    const first = (await claimOutput(row.id, 'old'))!;
    await fixture.pool.query("UPDATE ai_video_preparation_outputs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [row.id]);
    const second = (await claimOutput(row.id, 'new'))!;
    expect(await outputs.recordPreparedOutputMeasurement(fixture.pool, row.id, first.fence, measurement)).toBe(false);
    expect(await outputs.recordPreparedOutputMeasurement(fixture.pool, row.id, second.fence, measurement)).toBe(true);
    await expect(outputs.recordPreparedOutputMeasurement(fixture.pool, row.id, second.fence, { ...measurement, sha256: 'b'.repeat(64) })).rejects.toThrow(/immutable|changed/);
  });
  it('commits every output as unpublished restricted metadata only after all bytes are copied', async () => {
    const rows = (await ensure(2))!;
    const commit = () => outputs.commitPreparedOutputMetadata(fixture.pool, { attemptId: scope.attempt.id, attemptFence: scope.attempt.fence });
    expect(await commit()).toBeNull();
    for (const row of rows) {
      const claim = (await claimOutput(row.id, 'copy'))!;
      expect(await outputs.recordPreparedOutputMeasurement(fixture.pool, row.id, claim.fence, measurement)).toBe(true);
      await fixture.pool.query('UPDATE ai_video_preparation_outputs SET capacity_reserved=true WHERE id=$1', [row.id]);
      expect(await outputs.markPreparedOutputCopied(fixture.pool, row.id, claim.fence)).toBe(true);
      if (row.output_index === 0) expect(await commit()).toBeNull();
    }
    expect(await commit()).toEqual(rows.map(o => o.object_id));
    expect(await commit()).toEqual(rows.map(o => o.object_id));
    const stored = (await fixture.pool.query('SELECT * FROM storage_objects ORDER BY filename')).rows;
    expect(stored).toHaveLength(2);
    for (const object of stored) expect(object).toMatchObject({ user_id: null, access_scope: 'prepared_video', access_subject: 'fictional-subject', published_at: null, public: false, size_bytes: '128' });
  });
  it('does not attach allocated IDs to preexisting foreign metadata', async () => {
    const row = (await ensure())![0];
    const claim = (await claimOutput(row.id, 'copy'))!;
    await outputs.recordPreparedOutputMeasurement(fixture.pool, row.id, claim.fence, measurement);
    await fixture.pool.query('UPDATE ai_video_preparation_outputs SET capacity_reserved=true WHERE id=$1', [row.id]);
    await outputs.markPreparedOutputCopied(fixture.pool, row.id, claim.fence);
    await fixture.pool.query(`INSERT INTO storage_objects(id,app_id,organization_id,bucket,key,size_bytes,content_type) VALUES($1,$2,$3,'different-bucket','foreign',128,'video/mp4')`, [row.object_id, scope.app, scope.org]);
    await expect(outputs.commitPreparedOutputMetadata(fixture.pool, { attemptId: scope.attempt.id, attemptFence: scope.attempt.fence })).rejects.toThrow(/foreign|metadata|identity/i);
    expect((await fixture.pool.query('SELECT key FROM storage_objects WHERE id=$1', [row.object_id])).rows[0].key).toBe('foreign');
  });
  it('keeps tombstones after app deletion and rejects late commit or measurement', async () => {
    const row = (await ensure())![0];
    const claim = (await claimOutput(row.id, 'copy'))!;
    await fixture.pool.query('DELETE FROM apps WHERE id=$1', [scope.app]);
    expect(await outputs.recordPreparedOutputMeasurement(fixture.pool, row.id, claim.fence, measurement)).toBe(false);
    expect(await outputs.commitPreparedOutputMetadata(fixture.pool, { attemptId: scope.attempt.id, attemptFence: scope.attempt.fence })).toBeNull();
    expect((await outputs.listPreparedOutputs(fixture.pool, scope.attempt.id))[0]).toMatchObject({ object_id: row.object_id, object_key: row.object_key, state: 'cleanup_pending' });
  });
  it('does not issue claims from archived rows or while the app lock is held', async () => {
    const row = (await ensure())![0];
    const tx = await fixture.pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('SELECT id FROM apps WHERE id=$1 FOR UPDATE', [scope.app]);
      expect(await claimOutput(row.id, 'contended')).toBeNull();
      await tx.query('ROLLBACK');
    } finally { tx.release(); }
    await fixture.pool.query('UPDATE ai_video_preparation_outputs SET archived_after_move=$2 WHERE id=$1', [row.id, randomUUID()]);
    expect(await claimOutput(row.id, 'archived')).toBeNull();
  });
});
