import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPersonalAssistantModel, readModelPreference, saveModelPreference } from './model-preferences.js';
import { claimDueJobs, getEnabledJobForOrg } from './operator-store.js';

const connectionString = process.env.AGENT_MODEL_TEST_DATABASE_URL;
describe.skipIf(!connectionString)('model preferences on isolated PostgreSQL', () => {
  const schema = `model_settings_${randomUUID().replaceAll('-', '')}`;
  const owner = randomUUID(), member = randomUUID(), org = randomUUID(), other = randomUUID();
  const pool = new pg.Pool({ connectionString, max: 1 });
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    await pool.query(`CREATE TABLE platform_users(id uuid PRIMARY KEY);
      CREATE TABLE organizations(id uuid PRIMARY KEY);
      CREATE TABLE organization_members(user_id uuid REFERENCES platform_users(id), organization_id uuid REFERENCES organizations(id), role text);
      CREATE TABLE dashboard_agent_operator_jobs(id uuid PRIMARY KEY,organization_id uuid REFERENCES organizations(id),name text,instructions text,
        interval_seconds integer,next_run_at timestamptz,last_run_at timestamptz,created_at timestamptz DEFAULT now(),enabled boolean DEFAULT true);`);
    const migration = await readFile(new URL('../../../../../db/control-plane/149_agent_model_preferences.sql', import.meta.url), 'utf8');
    await pool.query(migration);
    await pool.query('INSERT INTO platform_users(id) VALUES($1),($2)', [owner, member]);
    await pool.query('INSERT INTO organizations(id) VALUES($1),($2)', [org, other]);
    await pool.query("INSERT INTO organization_members VALUES($1,$3,'owner'),($2,$3,'member')", [owner, member, org]);
    await pool.query("INSERT INTO dashboard_agent_operator_jobs(id,organization_id,name,instructions,interval_seconds,next_run_at) VALUES($1,$2,'sweep','Check',600,now()-interval '1 minute')", [randomUUID(), org]);
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); });
  it('isolates personal settings, supports reset and restricts organization writes to owners', async () => {
    await saveModelPreference(pool, { userId: owner }, 'vendor/personal');
    expect(await readPersonalAssistantModel(pool, owner)).toBe('vendor/personal');
    expect(await readModelPreference(pool, { userId: member })).toBeNull();
    await expect(saveModelPreference(pool, { userId: member, organizationId: org }, 'vendor/forbidden')).rejects.toMatchObject({ statusCode: 403 });
    await expect(readModelPreference(pool, { userId: owner, organizationId: other })).rejects.toMatchObject({ statusCode: 403 });
    await saveModelPreference(pool, { userId: owner }, null);
    expect(await readModelPreference(pool, { userId: owner })).toBeNull();
  });
  it('loads the owner-selected model into timer and event jobs, independently of personal preferences', async () => {
    await saveModelPreference(pool, { userId: owner, organizationId: org }, 'vendor/background');
    expect((await getEnabledJobForOrg(pool, org))?.model).toBe('vendor/background');
    const claimed = await claimDueJobs(pool, 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].model).toBe('vendor/background');
  });
});
