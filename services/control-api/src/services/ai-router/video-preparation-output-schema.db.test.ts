import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasBlockingPreparationWork } from './video-preparations.js';

const url = process.env.VIDEO_OUTPUT_TEST_DATABASE_URL;
const schema = `video_outputs_${randomUUID().replaceAll('-', '')}`;
const owner = randomUUID(), org = randomUUID();
let db: pg.Pool;
let preparation: string, attempt: string;
const object = randomUUID();
const key = `app-output/${owner}/${object}_generated-video-0`;

describe.skipIf(!url)('prepared output schema (isolated PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (parsed.hostname !== '127.0.0.1' || parsed.port !== '15439' || parsed.pathname !== '/portrait_test') throw new Error('Requires isolated output test database');
    db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},pg_catalog`, max: 8 });
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`CREATE TABLE apps(id text PRIMARY KEY,organization_id uuid NOT NULL,owner_id uuid NOT NULL,provisioning_status text NOT NULL DEFAULT 'ready');
      CREATE TABLE storage_objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,organization_id uuid NOT NULL,user_id uuid,bucket text NOT NULL,key text NOT NULL,filename text,content_type text,size_bytes bigint,public boolean NOT NULL DEFAULT false,metadata jsonb DEFAULT '{}',archived_after_move uuid,created_at timestamptz DEFAULT now(),UNIQUE(app_id,bucket,key));`);
    for (const name of ['056_ai_video_preparations.sql', '057_ai_video_preparation_schedule.sql', '058_ai_reference_lifecycle.sql', '061_ai_video_preparation_outputs.sql']) {
      await db.query(await readFile(new URL(`../../../../../db/runtime-plane/${name}`, import.meta.url), 'utf8'));
    }
  });
  afterAll(async () => { if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); } });
  beforeEach(async () => {
    await db.query('TRUNCATE apps,storage_objects,ai_video_preparation_outputs,ai_video_attempts,ai_video_preparations,ai_reference_assets,ai_reference_asset_groups CASCADE');
    await db.query('INSERT INTO apps(id,organization_id,owner_id) VALUES($1,$2,$3)', ['app-output', org, owner]);
    preparation = (await db.query(`INSERT INTO ai_video_preparations(organization_id,app_id,user_id,end_user_sub,model,request_json,deadline,input_expires_at)
      VALUES($1,'app-output',$2,'fictional-subject','example/video','{}',now()+interval '10 minutes',now()+interval '1 day') RETURNING id`, [org, owner])).rows[0].id;
    attempt = (await db.query(`INSERT INTO ai_video_attempts(preparation_id,organization_id,app_id,attempt_number,reservation_id,provider_slot,credential_namespace,billing_context,submission_state,provider_handle)
      VALUES($1,$2,'app-output',1,gen_random_uuid(),'example','credential-v1','{}','accepted','{"id":"accepted-video"}') RETURNING id`, [preparation, org])).rows[0].id;
  });
  const insert = async (changes: Record<string, unknown> = {}) => {
    const row = { preparation_id: preparation, attempt_id: attempt, organization_id: org, app_id: 'app-output', user_id: owner, end_user_sub: 'fictional-subject', output_index: 0, expected_outputs: 1, object_id: object, bucket: 'test-bucket', object_key: key, deadline: new Date(Date.now() + 300_000), ...changes };
    const columns = Object.keys(row);
    return (await db.query(`INSERT INTO ai_video_preparation_outputs(${columns.join(',')}) VALUES(${columns.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, Object.values(row))).rows[0];
  };

  it('preserves legacy storage defaults and supports exact non-UUID subjects without an app-user FK', async () => {
    const legacy = (await db.query(`INSERT INTO storage_objects(app_id,organization_id,bucket,key) VALUES('app-output',$1,'test-bucket','legacy') RETURNING access_scope,access_subject,published_at`, [org])).rows[0];
    expect(legacy).toEqual({ access_scope: 'app', access_subject: null, published_at: null });
    expect(await insert()).toMatchObject({ end_user_sub: 'fictional-subject', state: 'pending', object_id: object });
  });
  it('freezes allocated identity and rejects duplicate output indices', async () => {
    const row = await insert();
    await expect(insert({ object_id: randomUUID() })).rejects.toThrow(/unique|duplicate/i);
    for (const [column, value] of [['object_id', randomUUID()], ['object_key', key + '-changed'], ['end_user_sub', 'someone-else'], ['expected_outputs', 2]] as const) {
      await expect(db.query(`UPDATE ai_video_preparation_outputs SET ${column}=$2 WHERE id=$1`, [row.id, value])).rejects.toThrow(/immutable/);
    }
  });
  it('rejects output obligations outside the accepted attempt scope', async () => {
    await expect(insert({ organization_id: randomUUID() })).rejects.toThrow(/scope|admission/);
    await expect(insert({ end_user_sub: null })).rejects.toThrow(/scope|admission/);
    await db.query("UPDATE ai_video_attempts SET submission_state='uncertain' WHERE id=$1", [attempt]);
    await expect(insert()).rejects.toThrow(/accepted|admission/);
  });
  it('keeps cleanup identity after app deletion and forbids resurrection', async () => {
    const row = await insert();
    await db.query("UPDATE ai_video_preparation_outputs SET state='copying',lease_owner='worker',lease_expires_at=now()+interval '30 seconds',fence=fence+1,claim_attempt_fence=0,upload_uncertain_until=now()+interval '2 minutes',cleanup_probe_until=now()+interval '1 day' WHERE id=$1", [row.id]);
    await db.query("DELETE FROM apps WHERE id='app-output'");
    const retained = (await db.query('SELECT * FROM ai_video_preparation_outputs WHERE id=$1', [row.id])).rows[0];
    expect(retained).toMatchObject({ object_id: object, bucket: 'test-bucket', object_key: key, state: 'cleanup_pending', lease_owner: null });
    expect(retained.deleted_at).toBeInstanceOf(Date);
    expect(retained.cleanup_probe_until.getTime()).toBeGreaterThan(Date.now());
    await expect(db.query("UPDATE ai_video_preparation_outputs SET state='pending' WHERE id=$1", [row.id])).rejects.toThrow(/transition|deleted|cleanup/);
  });
  it('requires stored metadata before stored state and retains object-deletion cleanup', async () => {
    const row = await insert();
    await db.query("UPDATE ai_video_preparation_outputs SET state='copying' WHERE id=$1", [row.id]);
    await db.query("UPDATE ai_video_preparation_outputs SET state='copied',size_bytes=128,sha256=$2,content_type='video/mp4',capacity_reserved=true WHERE id=$1", [row.id, 'a'.repeat(64)]);
    await expect(db.query("UPDATE ai_video_preparation_outputs SET state='stored',capacity_reserved=false WHERE id=$1", [row.id])).rejects.toThrow(/metadata|object/);
    await db.query(`INSERT INTO storage_objects(id,app_id,organization_id,bucket,key,size_bytes,content_type,access_scope,access_subject) VALUES($1,'app-output',$2,'test-bucket',$3,128,'video/mp4','prepared_video','fictional-subject')`, [object, org, key]);
    await db.query("UPDATE ai_video_preparation_outputs SET state='stored',capacity_reserved=false WHERE id=$1", [row.id]);
    await db.query('DELETE FROM storage_objects WHERE id=$1', [object]);
    expect((await db.query('SELECT state,object_key,deleted_at FROM ai_video_preparation_outputs WHERE id=$1', [row.id])).rows[0]).toMatchObject({ state: 'cleanup_pending', object_key: key, deleted_at: expect.any(Date) });
  });
  it('does not let public flags or later updates downgrade a prepared object policy', async () => {
    await expect(db.query(`INSERT INTO storage_objects(app_id,organization_id,bucket,key,access_scope,public) VALUES('app-output',$1,'test-bucket','restricted','prepared_video',true)`, [org])).rejects.toThrow();
    const row = (await db.query(`INSERT INTO storage_objects(app_id,organization_id,bucket,key,access_scope,access_subject) VALUES('app-output',$1,'test-bucket','restricted','prepared_video','fictional-subject') RETURNING id`, [org])).rows[0];
    await expect(db.query("UPDATE storage_objects SET access_scope='app' WHERE id=$1", [row.id])).rejects.toThrow(/immutable|policy/);
    await expect(db.query("UPDATE storage_objects SET access_subject='another-subject' WHERE id=$1", [row.id])).rejects.toThrow(/immutable|policy/);
  });
  it('blocks a move on retained output work even when preparation/attempt work is drained', async () => {
    const row = await insert();
    await db.query("UPDATE ai_video_attempts SET submission_state='terminal',terminal_outcome='{\"status\":\"failed\"}',terminal_at=now(),settlement_status='acknowledged',settlement_receipt='{}',settled_at=now() WHERE id=$1", [attempt]);
    await db.query("UPDATE ai_video_preparations SET status='failed',terminal_outcome='{\"status\":\"failed\"}' WHERE id=$1", [preparation]);
    expect(await hasBlockingPreparationWork(db, 'app-output')).toBe(true);
    await expect(db.query("UPDATE apps SET provisioning_status='migrating' WHERE id='app-output'")).rejects.toThrow(/output|retained/);
    await db.query("UPDATE ai_video_preparation_outputs SET state='cleanup_pending' WHERE id=$1", [row.id]);
    await db.query("UPDATE ai_video_preparation_outputs SET state='deleted',deleted_at=now(),cleanup_probe_until=NULL WHERE id=$1", [row.id]);
    expect(await hasBlockingPreparationWork(db, 'app-output')).toBe(false);
    await expect(db.query("UPDATE apps SET provisioning_status='migrating' WHERE id='app-output'")).resolves.toBeDefined();
  });
});
