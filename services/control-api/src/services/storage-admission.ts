import type pg from 'pg';

export class StorageAdmissionError extends Error {
  constructor(public readonly code: string, public readonly permanent = true) { super(code); this.name = 'StorageAdmissionError'; }
}
/** Caller holds the app row lock. Count metadata plus retained, uncommitted copy reservations. */
export async function assertAppStorageAdmission(tx: pg.PoolClient, appId: string, bytes: number, contentType: string): Promise<void> {
  const fail = (code: string, permanent = true): never => { throw new StorageAdmissionError(code, permanent); };
  const app = (await tx.query('SELECT storage_config,provisioning_status FROM apps WHERE id=$1', [appId])).rows[0];
  if (!app || app.provisioning_status !== 'ready') fail('OUTPUT_APP_UNAVAILABLE', false);
  const config = app.storage_config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('OUTPUT_STORAGE_CONFIG_INVALID', false);
  const max = config.maxFileSizeMb ?? 10, limit = config.storageLimitBytes ?? 1024 * 1024 * 1024;
  const types = config.allowedContentTypes ?? ['*/*'];
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0 || !Number.isSafeInteger(limit) || limit < 0
    || !Array.isArray(types) || !types.every(t => typeof t === 'string')) fail('OUTPUT_STORAGE_CONFIG_INVALID', false);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > max * 1024 * 1024) fail('OUTPUT_FILE_SIZE_LIMIT');
  if (!types.some((t: string) => t === '*/*' || t === contentType || (t.endsWith('/*') && contentType.startsWith(t.slice(0, -1))))) fail('OUTPUT_CONTENT_TYPE_LIMIT');
  let used = Number((await tx.query('SELECT COALESCE(sum(size_bytes),0) AS bytes FROM storage_objects WHERE app_id=$1 AND archived_after_move IS NULL', [appId])).rows[0]?.bytes);
  const table = (await tx.query("SELECT to_regclass('ai_video_preparation_outputs') AS name")).rows[0]?.name;
  if (table) used += Number((await tx.query(`SELECT COALESCE(sum(o.size_bytes),0) AS bytes FROM ai_video_preparation_outputs o
    WHERE o.app_id=$1 AND o.archived_after_move IS NULL AND o.capacity_reserved
      AND NOT EXISTS(SELECT 1 FROM storage_objects s WHERE s.id=o.object_id AND s.app_id=o.app_id AND s.archived_after_move IS NULL)`, [appId])).rows[0]?.bytes);
  if (!Number.isSafeInteger(used) || used < 0) fail('OUTPUT_STORAGE_USAGE_UNAVAILABLE', false);
  if (used + bytes > limit) fail('OUTPUT_STORAGE_QUOTA');
}
/** Ordinary upload metadata uses the same app-first lock as generated-output reservations. */
export async function withAppStorageAdmission<T>(pool: pg.Pool, appId: string, bytes: number, contentType: string,
  operation: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT id FROM apps WHERE id=$1 FOR UPDATE', [appId]);
    await assertAppStorageAdmission(tx, appId, bytes, contentType);
    const result = await operation(tx); await tx.query('COMMIT'); return result;
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
