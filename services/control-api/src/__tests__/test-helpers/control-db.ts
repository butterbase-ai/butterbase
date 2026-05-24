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
  // platform_users left intact except those seeded by tests
  await controlDb.query("DELETE FROM platform_users WHERE email LIKE '%@x.com'");
}

export async function seedUser(email: string) {
  const id = randomUUID();
  await controlDb.query(
    `INSERT INTO platform_users (id, email, created_at) VALUES ($1, $2, now())`,
    [id, email]
  );
  return { id, email };
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
