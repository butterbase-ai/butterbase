import type pg from 'pg';

export interface AppEnvironmentLink {
  prod_app_id: string;
  staging_app_id: string;
  created_by: string;
  created_at: Date;
  last_promoted_at: Date | null;
  last_reset_at: Date | null;
}

export async function linkEnvironments(
  runtimeDb: pg.Pool,
  args: { prodAppId: string; stagingAppId: string; createdBy: string },
): Promise<AppEnvironmentLink> {
  // Idempotent for the IDENTICAL pair, because executeClone is resumable: a
  // retry after this insert already succeeded must not fail the job. A conflict
  // on prod_app_id where the staging app DIFFERS is a real error and must still
  // throw — silently keeping the old link would complete the job pointing at the
  // wrong staging app. The WHERE makes that case return zero rows.
  const res = await runtimeDb.query<AppEnvironmentLink>(
    `INSERT INTO app_environments (prod_app_id, staging_app_id, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (prod_app_id) DO UPDATE
       SET staging_app_id = EXCLUDED.staging_app_id
     WHERE app_environments.staging_app_id = EXCLUDED.staging_app_id
     RETURNING *`,
    [args.prodAppId, args.stagingAppId, args.createdBy],
  );
  if (res.rows.length === 0) {
    throw new Error(
      `app_environments already links ${args.prodAppId} to a different staging app`,
    );
  }
  return res.rows[0];
}

export async function getEnvironmentLink(
  runtimeDb: pg.Pool, prodAppId: string,
): Promise<AppEnvironmentLink | null> {
  const res = await runtimeDb.query<AppEnvironmentLink>(
    `SELECT * FROM app_environments WHERE prod_app_id = $1`, [prodAppId],
  );
  return res.rows[0] ?? null;
}

export async function getLinkByStagingApp(
  runtimeDb: pg.Pool, stagingAppId: string,
): Promise<AppEnvironmentLink | null> {
  const res = await runtimeDb.query<AppEnvironmentLink>(
    `SELECT * FROM app_environments WHERE staging_app_id = $1`, [stagingAppId],
  );
  return res.rows[0] ?? null;
}

export async function unlinkEnvironment(runtimeDb: pg.Pool, prodAppId: string): Promise<void> {
  await runtimeDb.query(`DELETE FROM app_environments WHERE prod_app_id = $1`, [prodAppId]);
}

/**
 * Column name is a closed union rather than a parameter because it is
 * interpolated into the SQL — a string parameter here would be an injection.
 */
export async function touchEnvironmentTimestamp(
  runtimeDb: pg.Pool,
  prodAppId: string,
  field: 'last_promoted_at' | 'last_reset_at',
): Promise<void> {
  const column = field === 'last_promoted_at' ? 'last_promoted_at' : 'last_reset_at';
  await runtimeDb.query(
    `UPDATE app_environments SET ${column} = now() WHERE prod_app_id = $1`, [prodAppId],
  );
}
