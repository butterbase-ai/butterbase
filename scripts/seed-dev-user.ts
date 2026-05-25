/**
 * Seeds platform_users rows for local development (AUTH_ENABLED=false).
 *
 * control-api attributes anonymous requests to DEV_OWNER_ID; quota enforcement
 * requires that user to exist in platform_users with a valid plan_id.
 *
 * Usage (stack running, migrations applied):
 *   NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control npm run seed:dev
 */
import pg from 'pg';

const DEFAULT_OWNER_ID = '11111111-1111-1111-1111-111111111111';
const DEFAULT_ADMIN_ID = '22222222-2222-2222-2222-222222222222';
const DEFAULT_PLAN_ID = 'playground';

const USERS = [
  {
    id: process.env.DEV_OWNER_ID ?? DEFAULT_OWNER_ID,
    email: 'dev@butterbase.local',
    cognitoSub: 'dev-local-owner',
  },
  {
    id: process.env.DEV_ADMIN_USER_ID ?? DEFAULT_ADMIN_ID,
    email: 'dev-admin@butterbase.local',
    cognitoSub: 'dev-local-admin',
  },
] as const;

async function seed(): Promise<void> {
  const url =
    process.env.NEON_PLATFORM_PRIMARY_URL ??
    process.env.CONTROL_DB_URL ??
    'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

  const planId = process.env.DEV_SEED_PLAN_ID ?? DEFAULT_PLAN_ID;
  const pool = new pg.Pool({ connectionString: url });

  try {
    const planCheck = await pool.query(`SELECT id FROM plans WHERE id = $1`, [planId]);
    if (planCheck.rows.length === 0) {
      throw new Error(
        `Plan "${planId}" not found. Run npm run migrate:control first, or set DEV_SEED_PLAN_ID to an existing plans.id.`
      );
    }

    for (const u of USERS) {
      await pool.query(
        `INSERT INTO platform_users (id, email, cognito_sub, email_verified, account_status, plan_id)
         VALUES ($1, $2, $3, true, 'active', $4)
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           cognito_sub = EXCLUDED.cognito_sub,
           email_verified = true,
           account_status = 'active',
           plan_id = EXCLUDED.plan_id`,
        [u.id, u.email, u.cognitoSub, planId]
      );
      console.log(`  seeded platform_users ${u.id} (${u.email}, plan=${planId})`);
    }

    console.log('Dev user seed complete.');
  } finally {
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Dev user seed error:', err);
  process.exit(1);
});
