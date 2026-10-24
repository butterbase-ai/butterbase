import type pg from 'pg';
import { ConflictError } from './api-errors.js';

export interface AppStateRef { app_id: string; region: string; organization_id: string | null }
export class AppStateBusyError extends ConflictError {
  constructor() { super('App state is changing. Retry the operation.', 'APP_STATE_BUSY'); }
}

/** Caller must own a transaction. Always acquire organization locks first.
 * Sorted index-row locks are shared by state writers and region cutovers.
 * The returned home is authoritative only while this transaction holds them.
 */
export async function lockAppStates(client: Pick<pg.PoolClient, 'query'>, appIds: string[]): Promise<AppStateRef[]> {
  await client.query("SET LOCAL lock_timeout = '5s'");
  return (await client.query<AppStateRef>(
    `SELECT app_id, region, organization_id FROM org_app_index
      WHERE app_id = ANY($1::text[]) ORDER BY app_id FOR UPDATE`,
    [[...new Set(appIds)].sort()],
  )).rows;
}

/** Database work only. Call listeners and external services after this returns. */
export async function withAppStateLocks<T>(
  controlDb: Pick<pg.Pool, 'connect'>,
  appIds: string[],
  work: (refs: AppStateRef[], client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await controlDb.connect();
  try {
    await client.query('BEGIN');
    const result = await work(await lockAppStates(client, appIds), client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if ((err as { code?: string }).code === '55P03') throw new AppStateBusyError();
    throw err;
  } finally { client.release(); }
}
