/**
 * Investigate who's blocked from being deleted by the
 * hackathon_participants.user_id NOT NULL + FK SET NULL conflict.
 *
 * The Failing row in the storm contains user_id ca773776-514b-4e16-b7b4-1ceca2cf01c4.
 * This script confirms which user that is and what's blocking the cascade.
 */
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.CONTROL_DB_URL });

async function main() {
  const targetUserId = 'ca773776-514b-4e16-b7b4-1ceca2cf01c4';

  console.log(`\n=== platform_users row for ${targetUserId} ===`);
  const u = await pool.query(
    'SELECT id, email, account_status, created_at FROM platform_users WHERE id = $1',
    [targetUserId]
  );
  for (const r of u.rows) console.log(JSON.stringify(r));
  if (u.rowCount === 0) console.log('(no user found — already deleted?)');

  console.log(`\n=== hackathon_participants rows for ${targetUserId} ===`);
  const p = await pool.query(
    `SELECT id, hackathon_id, user_id, source, status, created_at
       FROM hackathon_participants WHERE user_id = $1`,
    [targetUserId]
  );
  for (const r of p.rows) console.log(JSON.stringify(r));
  if (p.rowCount === 0) console.log('(no participant rows)');

  console.log(`\n=== hackathon_submissions linked to those participants ===`);
  const s = await pool.query(
    `SELECT s.id, s.hackathon_id, s.participant_id, s.created_at
       FROM hackathon_submissions s
       JOIN hackathon_participants hp ON hp.id = s.participant_id
      WHERE hp.user_id = $1`,
    [targetUserId]
  );
  for (const r of s.rows) console.log(JSON.stringify(r));
  if (s.rowCount === 0) console.log('(no submissions)');

  console.log(`\n=== Other rows referencing this user_id (excluding cascade-safe tables) ===`);
  // Just spot-check a few high-traffic tables. The proper diagnosis comes from
  // pg_constraint, but those four cover most blockers.
  for (const table of ['apps', 'api_keys', 'subscriptions', 'platform_users']) {
    const col = table === 'platform_users' ? 'id' : 'user_id';
    try {
      const r = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [targetUserId]);
      console.log(`  ${table}.${col}: ${r.rows[0].n}`);
    } catch (err) {
      console.log(`  ${table}.${col}: ERR ${(err as Error).message}`);
    }
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
