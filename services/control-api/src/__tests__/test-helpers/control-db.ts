import pg from 'pg';
import { randomUUID } from 'node:crypto';

export const controlDb = new pg.Pool({
  connectionString: process.env.CONTROL_DB_URL ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control',
});

/**
 * Runtime DB pool — feature tables (app_functions, app_db_connections, etc.) live here
 * post the controlplane-apps refactor. Tests that exercise scoring/feature-count logic
 * should seed feature rows into this pool and mock `getRuntimeDbForApp` to return it.
 */
export const runtimeDb = new pg.Pool({
  connectionString: process.env.RUNTIME_DB_URL ?? 'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us',
});

export async function setupTestDb() {
  await controlDb.query('DELETE FROM hackathon_scores');
  await controlDb.query('DELETE FROM hackathon_submissions');
  await controlDb.query('DELETE FROM hackathon_participants');
  await controlDb.query('DELETE FROM hackathons');
  // platform_users left intact except those seeded by tests. Also purge each
  // seeded user's personal org + owner membership (both created by Plan 05
  // signup hook + seedUser helper).
  //
  // Ordering MUST be: capture owner_ids → delete platform_users first →
  // delete organizations. Because `platform_users.personal_organization_id`
  // FKs `organizations(id)`, deleting orgs while users still reference them
  // hits an FK violation. `organization_members.user_id` cascades on user
  // delete so that's handled implicitly.
  const { rows: seededUsers } = await controlDb.query<{ id: string }>(
    "SELECT id FROM platform_users WHERE email LIKE '%@x.com'"
  );
  const seededUserIds = seededUsers.map((r) => r.id);
  await controlDb.query("DELETE FROM platform_users WHERE email LIKE '%@x.com'");
  if (seededUserIds.length > 0) {
    await controlDb.query(
      `DELETE FROM organizations WHERE owner_id = ANY($1::uuid[]) AND personal = true`,
      [seededUserIds]
    );
  }
}

/**
 * Create a personal organization for the given user (Plan 05 pattern).
 * Order-safe: organizations.owner_id has no FK to platform_users, so this
 * can be called before the platform_users INSERT. Returns the org id.
 *
 * Callers that already have a platform_users row: use this to backfill
 * `personal_organization_id` on it — but by convention every new seed goes
 * through `seedUser` below.
 */
export async function ensurePersonalOrg(userId: string, email: string): Promise<string> {
  const local = email.split('@')[0] ?? 'user';
  const { rows } = await controlDb.query<{ id: string }>(
    `INSERT INTO organizations (
        owner_id, name, personal,
        plan_id, credits_usd, auto_refill_enabled, account_status
     )
     VALUES ($1, $2, true, 'playground', 0, false, 'active')
     RETURNING id`,
    [userId, `${local}'s org`]
  );
  return rows[0]!.id;
}

/**
 * Post-Plan-05, platform_users.personal_organization_id is NOT NULL. Seeding
 * a user now requires creating the personal org first (owner_id has no FK
 * to platform_users, so this is safe), inserting the user with
 * `personal_organization_id` populated, and adding the owner membership row.
 * Mirrors dashboard-api's Plan 05 get_auth_context transaction shape.
 */
export async function seedUser(email: string) {
  const id = randomUUID();
  const client = await controlDb.connect();
  try {
    await client.query('BEGIN');
    const local = email.split('@')[0] ?? 'user';
    const orgResult = await client.query<{ id: string }>(
      `INSERT INTO organizations (
          owner_id, name, personal,
          plan_id, credits_usd, auto_refill_enabled, account_status
       )
       VALUES ($1, $2, true, 'playground', 0, false, 'active')
       RETURNING id`,
      [id, `${local}'s org`]
    );
    const personalOrgId = orgResult.rows[0]!.id;
    await client.query(
      `INSERT INTO platform_users (id, email, created_at, personal_organization_id)
       VALUES ($1, $2, now(), $3)`,
      [id, email, personalOrgId]
    );
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role, joined_at)
       VALUES ($1, $2, 'owner', now())
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [personalOrgId, id]
    );
    await client.query('COMMIT');
    return { id, email, personalOrgId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function seedHackathon(opts: {
  slug: string;
  is_active?: boolean;
  starts_at?: Date;
  ends_at?: Date;
  submission_deadline?: Date;
  field_schema?: unknown;
  submission_code_hash?: string;
  judge_code_hash?: string;
}) {
  const id = randomUUID();
  const starts = opts.starts_at ?? new Date(Date.now() - 3600_000);
  const ends = opts.ends_at ?? new Date(Date.now() + 86400_000);
  const dl = opts.submission_deadline ?? ends;
  const subHash = opts.submission_code_hash ?? 'TEST_SUBMISSION_HASH';
  const judgeHash = opts.judge_code_hash ?? 'TEST_JUDGE_HASH';
  await controlDb.query(
    `INSERT INTO hackathons (id, slug, name, starts_at, ends_at, submission_deadline, field_schema, is_active,
                             submission_code_hash, judge_code_hash)
     VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, opts.slug, starts, ends, dl, JSON.stringify(opts.field_schema ?? { fields: [] }), opts.is_active ?? false, subHash, judgeHash]
  );
  return { id, slug: opts.slug };
}

export async function seedParticipant(opts: {
  hackathon_id: string;
  user_id: string;
  email?: string | null;
  source?: 'mcp_self_register' | 'admin_panel' | 'api' | 'csv_import';
  status?: 'active' | 'revoked';
}) {
  const id = randomUUID();
  await controlDb.query(
    `INSERT INTO hackathon_participants (id, hackathon_id, email, user_id, source, status)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, opts.hackathon_id, opts.email ?? null, opts.user_id, opts.source ?? 'mcp_self_register', opts.status ?? 'active']
  );
  return { id };
}
