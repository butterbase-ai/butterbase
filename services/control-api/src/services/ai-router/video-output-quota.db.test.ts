import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPreparedOutputTestDb } from '../../../test/fixtures/prepared-output-db.js';
import { assertAppStorageAdmission, withAppStorageAdmission } from '../storage-admission.js';
import * as outputs from './video-preparation-outputs.js';

describe.skipIf(!process.env.VIDEO_OUTPUT_TEST_DATABASE_URL)('shared output and ordinary upload admission (isolated PostgreSQL)', () => {
  let db: Awaited<ReturnType<typeof createPreparedOutputTestDb>>, scope: Awaited<ReturnType<typeof db.seed>>;
  beforeAll(async () => { db = await createPreparedOutputTestDb(); });
  beforeEach(async () => { await db.reset(); scope = await db.seed(); });
  afterAll(async () => { await db?.close(); });
  const config = async (value: object) => db.pool.query('UPDATE apps SET storage_config=$2 WHERE id=$1', [scope.app, value]);
  const upload = () => withAppStorageAdmission(db.pool, scope.app, 128, 'video/mp4', async tx => {
    await tx.query(`INSERT INTO storage_objects(app_id,organization_id,bucket,key,size_bytes,content_type) VALUES($1,$2,'test','ordinary-'||gen_random_uuid(),128,'video/mp4')`, [scope.app, scope.org]); return true;
  });
  it('serializes ordinary admissions and includes existing metadata', async () => {
    await config({ storageLimitBytes: 200 });
    const results = await Promise.allSettled([upload(), upload()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await db.pool.query('SELECT sum(size_bytes)::int AS bytes FROM storage_objects')).rows[0].bytes).toBe(128);
  });
  it('reserves copies against ordinary uploads without double-counting an already reserved output', async () => {
    await config({ storageLimitBytes: 200 });
    const row = (await outputs.ensurePreparedOutputs(db.pool, { attemptId: scope.attempt.id, attemptFence: 1, count: 1, bucket: 'test-bucket' }))![0];
    const claim = (await outputs.claimPreparedOutput(db.pool, row.id, { attemptFence: 1, worker: 'copy' }))!;
    await outputs.recordPreparedOutputMeasurement(db.pool, row.id, claim.fence, { sizeBytes: 128, sha256: 'a'.repeat(64), contentType: 'video/mp4' });
    expect(await outputs.reservePreparedOutputCapacity(db.pool, row.id, claim.fence)).toBe(true);
    expect(await outputs.reservePreparedOutputCapacity(db.pool, row.id, claim.fence)).toBe(true);
    await expect(upload()).rejects.toMatchObject({ code: 'OUTPUT_STORAGE_QUOTA' });
    expect(await outputs.reservePreparedOutputCapacity(db.pool, row.id, 99)).toBe(false);
  });
  it('enforces app size, exact MIME wildcards and fails closed on invalid configuration', async () => {
    await config({ maxFileSizeMb: 0.00001 }); await expect(upload()).rejects.toMatchObject({ code: 'OUTPUT_FILE_SIZE_LIMIT' });
    await config({ allowedContentTypes: ['vid/*'] }); await expect(upload()).rejects.toMatchObject({ code: 'OUTPUT_CONTENT_TYPE_LIMIT' });
    await config({ allowedContentTypes: ['video/*'] }); expect(await upload()).toBe(true);
    await config({ storageLimitBytes: 'unlimited' }); await expect(upload()).rejects.toMatchObject({ code: 'OUTPUT_STORAGE_CONFIG_INVALID' });
  });
  it('can check inside the existing app-first transaction and rejects a deleted or migrating app', async () => {
    const tx = await db.pool.connect();
    try { await tx.query('BEGIN'); await tx.query('SELECT id FROM apps WHERE id=$1 FOR UPDATE', [scope.app]);
      await expect(assertAppStorageAdmission(tx, scope.app, 128, 'video/mp4')).resolves.toBeUndefined();
      await tx.query('ROLLBACK');
    } finally { tx.release(); }
    await db.pool.query("UPDATE apps SET provisioning_status='migration_target_reserved' WHERE id=$1", [scope.app]);
    await expect(upload()).rejects.toMatchObject({ code: 'OUTPUT_APP_UNAVAILABLE' });
    await db.pool.query('DELETE FROM apps WHERE id=$1', [scope.app]);
    await expect(upload()).rejects.toMatchObject({ code: 'OUTPUT_APP_UNAVAILABLE' });
  });
});
