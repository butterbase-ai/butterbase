/**
 * Count platform users who have hackathon_participants rows and would
 * therefore hit the FK SET NULL → NOT NULL conflict when trying to delete
 * their account. Pre-migration-052 baseline.
 */
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.CONTROL_DB_URL });

async function main() {
  const r = await pool.query<{ user_id: string; email: string | null; n: number }>(
    `SELECT hp.user_id, u.email, count(*)::int AS n
       FROM hackathon_participants hp
       JOIN platform_users u ON u.id = hp.user_id
      GROUP BY hp.user_id, u.email
      ORDER BY n DESC, u.email`
  );
  console.log(`${r.rowCount} users currently have hackathon_participants rows.`);
  for (const row of r.rows.slice(0, 25)) {
    console.log(`  ${row.email ?? '(no email)'} (${row.user_id}): ${row.n}`);
  }
  if (r.rowCount! > 25) console.log(`  ... and ${r.rowCount! - 25} more`);
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end().catch(() => {}); process.exit(1); });
