import type pg from 'pg';

export interface UserAppIndexRow {
  app_id: string;
  user_id: string;
  region: string;
  subdomain: string | null;
  app_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AddArgs {
  userId: string;
  appId: string;
  region: string;
  subdomain?: string;
  appName?: string;
}

export async function addUserAppIndex(controlPool: pg.Pool, args: AddArgs): Promise<void> {
  await controlPool.query(
    `INSERT INTO user_app_index (app_id, user_id, region, subdomain, app_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (app_id) DO UPDATE
     SET region = EXCLUDED.region,
         subdomain = COALESCE(EXCLUDED.subdomain, user_app_index.subdomain),
         app_name = COALESCE(EXCLUDED.app_name, user_app_index.app_name),
         updated_at = now()`,
    [args.appId, args.userId, args.region, args.subdomain ?? null, args.appName ?? null],
  );
}

export async function removeUserAppIndex(controlPool: pg.Pool, appId: string): Promise<void> {
  await controlPool.query(`DELETE FROM user_app_index WHERE app_id = $1`, [appId]);
}

export async function updateUserAppIndexRegion(
  controlPool: pg.Pool,
  appId: string,
  region: string,
): Promise<void> {
  await controlPool.query(
    `UPDATE user_app_index SET region = $2, updated_at = now() WHERE app_id = $1`,
    [appId, region],
  );
}

export async function listUserApps(controlPool: pg.Pool, userId: string): Promise<UserAppIndexRow[]> {
  const r = await controlPool.query<UserAppIndexRow>(
    `SELECT app_id, user_id, region, subdomain, app_name, created_at, updated_at
     FROM user_app_index
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return r.rows;
}
