import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

export async function createPreparedOutputTestDb() {
  const url = process.env.VIDEO_OUTPUT_TEST_DATABASE_URL;
  if (!url) throw new Error('VIDEO_OUTPUT_TEST_DATABASE_URL required');
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== '15439' || parsed.pathname !== '/portrait_test') throw new Error('Requires isolated output test database');
  const schema = `video_output_repository_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},pg_catalog`, max: 12 });
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE apps(id text PRIMARY KEY,organization_id uuid NOT NULL,owner_id uuid NOT NULL,provisioning_status text NOT NULL DEFAULT 'ready',storage_config jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE storage_objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,organization_id uuid NOT NULL,user_id uuid,bucket text NOT NULL,key text NOT NULL,filename text,content_type text,size_bytes bigint,public boolean NOT NULL DEFAULT false,metadata jsonb DEFAULT '{}',archived_after_move uuid,created_at timestamptz DEFAULT now(),UNIQUE(app_id,bucket,key));`);
  for (const name of ['056_ai_video_preparations.sql', '057_ai_video_preparation_schedule.sql', '058_ai_reference_lifecycle.sql', '061_ai_video_preparation_outputs.sql']) await pool.query(await readFile(new URL(`../../../../db/runtime-plane/${name}`, import.meta.url), 'utf8'));
  return {
    pool,
    async reset() { await pool.query('TRUNCATE apps,storage_objects,ai_video_preparation_outputs,ai_video_attempts,ai_video_preparations,ai_reference_assets,ai_reference_asset_groups CASCADE'); },
    async close() { try { await pool.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await pool.end(); } },
    async seed(subject: string | null = 'fictional-subject', suffix = '') {
      const owner = randomUUID(), org = randomUUID(), app = `app-output${suffix}`;
      await pool.query('INSERT INTO apps(id,organization_id,owner_id) VALUES($1,$2,$3)', [app, org, owner]);
      const job = (await pool.query(`INSERT INTO ai_video_preparations(organization_id,app_id,user_id,end_user_sub,model,request_json,deadline,input_expires_at)
        VALUES($1,$2,$3,$4,'example/video',$5,now()+interval '10 minutes',now()+interval '1 day') RETURNING *`,
      [org, app, owner, subject, { request: { model: 'example/video' }, selection: { providerSlot: 'example', credentialNamespace: 'credential-v1', billingContext: {} } }])).rows[0];
      const attempt = (await pool.query(`INSERT INTO ai_video_attempts(preparation_id,organization_id,app_id,attempt_number,reservation_id,provider_slot,credential_namespace,billing_context,submission_state,provider_handle,fence,lease_owner,lease_expires_at)
        VALUES($1,$2,$3,1,gen_random_uuid(),'example','credential-v1','{}','accepted','{"id":"accepted-video"}',1,'poller',now()+interval '60 seconds') RETURNING *`, [job.id, org, app])).rows[0];
      return { owner, org, app, job, attempt };
    },
  };
}
