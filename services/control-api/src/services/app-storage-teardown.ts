// services/control-api/src/services/app-storage-teardown.ts
//
// Deletes an app's uploaded object BYTES when the app is deprovisioned.
//
// WHY THIS EXISTS. `storage_objects.app_id` is `REFERENCES apps(id) ON DELETE
// CASCADE`, so `DELETE FROM apps` in `executeDeprovision` removes every row
// that names the app's files — and nothing at all removes the files. Before
// staging environments that was a storage-cost bug: the bytes were unreachable
// (the only rows that pointed at them were gone) and nobody could read them
// back through the API. It is now a data-retention bug, because
// `cloud/overlays/app-copy/phases/storage.ts` writes a SECOND physical copy of
// a customer's uploaded files into every staging environment, under a rewritten
// `${stagingAppId}/...` key. Deleting the staging app therefore left that
// second copy of the customer's personal data in the bucket permanently, with
// no row, no sweeper and no operator-visible handle to find it by.
//
// The account-deletion path in `routes/billing.ts` (step 3c) already does
// exactly this for every app a departing user owns. This is the same deletion,
// moved onto the per-app path so it also runs when a single app — a staging app
// in particular — is deleted on its own.
//
// SHARED-KEY GUARD. `rewriteObjectKey` DECLINES to rewrite a key it does not
// recognise ("not the layout we know; do not guess") and returns it verbatim.
// A copied object whose key was declined therefore has the staging app's row
// pointing at PRODUCTION'S key. A naive "delete every key this app owns" would
// then destroy the production app's only copy of that file when its staging
// sibling is deleted — turning a retention fix into data loss. So every key is
// checked against the rest of `storage_objects` first, and one still referenced
// by any OTHER app is left alone and counted as `shared`.
//
// NEVER LOGS A KEY. An object key ends in `${uuid}_${filename}`, so the key is
// itself personal data. Callers get counts only.

import type pg from 'pg';

export interface AppStorageTeardownResult {
  /** Objects whose bytes this run deleted. */
  deleted: number;
  /** Objects left alone because another app's row still references the key. */
  shared: number;
  /** Objects whose delete threw. The rows still cascade away; bytes remain. */
  failed: number;
  /** Total `storage_objects` rows the app owned. */
  total: number;
}

export interface TeardownAppStorageArgs {
  /** Regional runtime pool — `storage_objects` is a runtime-tier table. */
  runtimeDb: pg.Pool;
  appId: string;
  /**
   * Injected so this is testable without an S3 endpoint, and so the caller
   * owns which client (S3 or R2) is used.
   */
  deleteObject(key: string): Promise<void>;
}

/**
 * Best-effort by contract: never throws. App deletion must not be blocked by a
 * storage backend that is down — the rows cascade away regardless, and a
 * failure count is returned so the caller can log (and an operator can tell the
 * difference between "nothing to delete" and "we could not delete it").
 */
export async function teardownAppStorage(
  args: TeardownAppStorageArgs,
): Promise<AppStorageTeardownResult> {
  const { runtimeDb, appId, deleteObject } = args;

  let rows: { bucket: string; key: string }[];
  try {
    const res = await runtimeDb.query<{ bucket: string; key: string }>(
      'SELECT bucket, key FROM storage_objects WHERE app_id = $1',
      [appId],
    );
    rows = res.rows;
  } catch {
    // Cannot enumerate — report nothing rather than guess at keys.
    return { deleted: 0, shared: 0, failed: 0, total: 0 };
  }

  const result: AppStorageTeardownResult = {
    deleted: 0, shared: 0, failed: 0, total: rows.length,
  };

  for (const row of rows) {
    let sharedWithAnotherApp = false;
    try {
      const other = await runtimeDb.query<{ one: number }>(
        `SELECT 1 AS one FROM storage_objects
          WHERE bucket = $1 AND key = $2 AND app_id <> $3 LIMIT 1`,
        [row.bucket, row.key, appId],
      );
      sharedWithAnotherApp = other.rows.length > 0;
    } catch {
      // Could not prove the key is ours alone. Refuse to delete: a missed
      // object costs storage, a wrong one destroys another app's only copy.
      result.failed++;
      continue;
    }

    if (sharedWithAnotherApp) {
      result.shared++;
      continue;
    }

    try {
      await deleteObject(row.key);
      result.deleted++;
    } catch {
      result.failed++;
    }
  }

  return result;
}
