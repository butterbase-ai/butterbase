import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreparedOutputTestDb } from '../../test/fixtures/prepared-output-db.js';

const seams = vi.hoisted(() => ({ pool: null as any, owner: '', org: '', downloads: 0 }));
vi.mock('../services/runtime-db.js', () => ({ getRuntimeDbPool: () => seams.pool }));
vi.mock('../services/region-resolver.js', () => ({ resolveAppHomeRegion: async () => 'us-east-1', getRuntimeDbForApp: async () => seams.pool }));
vi.mock('../services/org-resolver.js', () => ({ resolveOrganizationId: async () => seams.org }));
vi.mock('../services/usage-metering.js', () => ({ incrementUsage: vi.fn(async () => {}) }));
vi.mock('../services/audit/with-audit.js', () => ({ logFromRequest: vi.fn() }));
vi.mock('../services/end-user-auth.js', () => ({ verifyEndUserJwt: async (_db: unknown, _app: string, token: string) => ({ sub: token }) }));
vi.mock('../services/app-resolver.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/app-resolver.js')>();
  return { ...actual, AppResolver: { resolveApp: async (_db: unknown, appId: string, userId: string) => {
    const row = (await seams.pool.query('SELECT * FROM apps WHERE id=$1', [appId])).rows[0];
    if (!row || row.owner_id !== userId) throw new actual.AppNotFoundError(appId);
    return row;
  } } };
});
vi.mock('../services/s3.js', () => ({
  generatePresignedUploadUrl: vi.fn(async (appId: string, owner: string) => ({ objectKey: `${appId}/${owner}/${randomUUID()}_video.mp4`, uploadUrl: 'https://objects.example/upload', expiresIn: 300 })),
  generatePresignedDownloadUrl: vi.fn(async () => `https://objects.example/download?nonce=${++seams.downloads}`),
  deleteObject: vi.fn(async () => {}),
  S3Error: class S3Error extends Error {},
}));
import { storageRoutes } from './storage.js';
import { deleteObject, generatePresignedDownloadUrl } from '../services/s3.js';
import * as outputs from '../services/ai-router/video-preparation-outputs.js';
import { teardownAppStorage } from '../services/app-storage-teardown.js';

let fixture: Awaited<ReturnType<typeof createPreparedOutputTestDb>>;
let scope: Awaited<ReturnType<typeof fixture.seed>>;
let app: ReturnType<typeof Fastify>;
let owned: string, foreign: string, pending: string, platformOnly: string, legacy: string;
const subject = 'fictional-subject';

describe.skipIf(!process.env.VIDEO_OUTPUT_TEST_DATABASE_URL)('prepared storage HTTP access (isolated PostgreSQL)', () => {
  beforeAll(async () => {
    fixture = await createPreparedOutputTestDb(); seams.pool = fixture.pool;
    await fixture.pool.query(`ALTER TABLE apps ALTER COLUMN storage_config SET DEFAULT '{"publicReadEnabled":true}';
      ALTER TABLE apps ADD COLUMN paused boolean DEFAULT false,ADD COLUMN paused_reason text,ADD COLUMN paused_by text`);
    app = Fastify(); app.decorate('controlDb', fixture.pool);
    app.addHook('onRequest', async request => {
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      request.auth = { userId: token === 'owner' ? seams.owner : token, authMethod: token === 'owner' ? 'api_key' : 'end_user_jwt', rawToken: token } as any;
    });
    await app.register(storageRoutes); await app.ready();
  });
  afterAll(async () => { await app?.close(); await fixture?.close(); });
  async function insert(policy: 'app' | 'prepared_video', accessSubject: string | null, published: boolean) {
    const id = randomUUID();
    await fixture.pool.query(`INSERT INTO storage_objects(id,app_id,organization_id,bucket,key,filename,content_type,size_bytes,user_id,access_scope,access_subject,published_at)
      VALUES($1,$2,$3,'test-bucket',$4,'video.mp4','video/mp4',128,$5,$6,$7,$8)`,
    [id, scope.app, scope.org, `${scope.app}/${scope.owner}/${id}_video.mp4`, policy === 'app' ? randomUUID() : null, policy, accessSubject, published ? new Date() : null]);
    return id;
  }
  beforeEach(async () => {
    await fixture.reset(); scope = await fixture.seed(); seams.owner = scope.owner; seams.org = scope.org; seams.downloads = 0; vi.clearAllMocks();
    owned = await insert('prepared_video', subject, true);
    foreign = await insert('prepared_video', 'different-subject', true);
    pending = await insert('prepared_video', subject, false);
    platformOnly = await insert('prepared_video', null, true);
    legacy = await insert('app', null, false);
  });
  const get = (id: string, actor = subject) => app.inject({ method: 'GET', url: `/storage/${scope.app}/download/${id}`, headers: { authorization: `Bearer ${actor}` } });

  it('does not let app-wide publicReadEnabled expose another subject, owner-only or unpublished video', async () => {
    for (const id of [foreign, platformOnly, pending]) expect((await get(id)).statusCode).toBe(404);
    expect(generatePresignedDownloadUrl).not.toHaveBeenCalled();
  });
  it('lists exact-subject published files without casting arbitrary subjects to UUID', async () => {
    const response = await app.inject({ method: 'GET', url: `/storage/${scope.app}/objects`, headers: { authorization: `Bearer ${subject}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().objects.map((o: { id: string }) => o.id)).toEqual([owned]);
  });
  it('resolves a fresh download URL on each authorized load', async () => {
    const first = await get(owned), second = await get(owned);
    expect(first.statusCode).toBe(200); expect(second.statusCode).toBe(200);
    expect(first.json().downloadUrl).not.toBe(second.json().downloadUrl);
    expect(generatePresignedDownloadUrl).toHaveBeenCalledTimes(2);
  });
  it('lets the authorized platform owner read published subjects but hides unpublished objects', async () => {
    expect((await get(foreign, 'owner')).statusCode).toBe(200);
    expect((await get(platformOnly, 'owner')).statusCode).toBe(200);
    expect((await get(pending, 'owner')).statusCode).toBe(404);
    const response = await app.inject({ method: 'GET', url: `/storage/${scope.app}/objects`, headers: { authorization: 'Bearer owner' } });
    expect(response.json().objects.map((o: { id: string }) => o.id).sort()).toEqual([owned, foreign, platformOnly, legacy].sort());
  });
  it('preserves publicReadEnabled for ordinary legacy storage', async () => {
    expect((await get(legacy)).statusCode).toBe(200);
  });
  it('allows deletion only for the exact subject or authorized platform owner', async () => {
    for (const [id, actor] of [[owned,subject],[platformOnly,null]]) {
      const job = (await fixture.pool.query(`INSERT INTO ai_video_preparations(organization_id,app_id,user_id,end_user_sub,model,request_json,deadline,input_expires_at)
        SELECT organization_id,app_id,user_id,$2,model,request_json,deadline,input_expires_at FROM ai_video_preparations WHERE id=$1 RETURNING id`, [scope.job.id, actor])).rows[0];
      const attempt = (await fixture.pool.query(`INSERT INTO ai_video_attempts(preparation_id,organization_id,app_id,attempt_number,reservation_id,provider_slot,credential_namespace,billing_context,submission_state,provider_handle,fence,lease_owner,lease_expires_at)
        SELECT $2,organization_id,app_id,1,gen_random_uuid(),provider_slot,credential_namespace,billing_context,'accepted',provider_handle,1,'copy',now()+interval '60 seconds' FROM ai_video_attempts WHERE id=$1 RETURNING id`, [scope.attempt.id, job.id])).rows[0];
      await fixture.pool.query(`INSERT INTO ai_video_preparation_outputs(preparation_id,attempt_id,organization_id,app_id,user_id,end_user_sub,output_index,expected_outputs,object_id,bucket,object_key,deadline)
        SELECT $2,$3,organization_id,app_id,$4,$5,0,1,id,bucket,key,now()+interval '5 minutes' FROM storage_objects WHERE id=$1`, [id,job.id,attempt.id,scope.owner,actor]);
    }
    const remove = (id: string, actor = subject) => app.inject({ method: 'DELETE', url: `/storage/${scope.app}/${id}`, headers: { authorization: `Bearer ${actor}` } });
    expect((await remove(foreign)).statusCode).toBe(404);
    expect((await remove(pending, 'owner')).statusCode).toBe(404);
    expect(deleteObject).not.toHaveBeenCalled();
    expect((await remove(owned)).statusCode).toBe(204);
    expect((await get(owned)).statusCode).toBe(404);
    expect((await remove(platformOnly, 'owner')).statusCode).toBe(204);
    expect(deleteObject).not.toHaveBeenCalled();
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM ai_video_preparation_outputs WHERE state='cleanup_pending'")).rows[0].n).toBe(2);
  });
  it('leaves managed generated bytes to the retained cleanup ledger during app teardown', async () => {
    const remove = vi.fn(async () => {});
    const result = await teardownAppStorage({ runtimeDb: fixture.pool, appId: scope.app, deleteObject: remove });
    expect(result.deleted).toBe(1);expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(expect.stringContaining(legacy));
  });
  it('rechecks ordinary uploads against retained copy reservations inside shared admission', async () => {
    await fixture.pool.query('UPDATE apps SET storage_config=$2 WHERE id=$1', [scope.app, { storageLimitBytes: 800 }]);
    const row = (await outputs.ensurePreparedOutputs(fixture.pool, { attemptId: scope.attempt.id, attemptFence: 1, count: 1, bucket: 'test-bucket' }))![0];
    const claim = (await outputs.claimPreparedOutput(fixture.pool, row.id, { attemptFence: 1, worker: 'copy' }))!;
    await outputs.recordPreparedOutputMeasurement(fixture.pool, row.id, claim.fence, { sizeBytes: 128, sha256: 'a'.repeat(64), contentType: 'video/mp4' });
    expect(await outputs.reservePreparedOutputCapacity(fixture.pool, row.id, claim.fence)).toBe(true);
    const response = await app.inject({ method: 'POST', url: `/storage/${scope.app}/upload`, headers: { authorization: 'Bearer owner' }, payload: { filename: 'video.mp4', contentType: 'video/mp4', sizeBytes: 128 } });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('QUOTA_STORAGE_EXCEEDED');
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM storage_objects')).rows[0].n).toBe(5);
  });
});
