/** Postgres `datname` limit. `custDbNameFor` truncates to this. */
export const PG_MAX_DATNAME = 63;

/**
 * The `cust_<appId>_<region>` move-app destination database name used by the
 * local and legacy (non-project-per-tenant) branches of `provisionAppDb`.
 *
 * Exported so `neon-orphan-reconciler.ts` can reproduce it EXACTLY when
 * deciding which `cust_*` databases belong to live apps — any drift here
 * silently reclassifies live customer databases as orphans and deletes them.
 * Keep this the single source of truth for the naming; do not fork a copy.
 */
export function custDbNameFor(appId: string, region: string): string {
  return `cust_${appId.replace(/-/g, '_')}_${region.replace(/-/g, '_')}`
    .toLowerCase()
    .slice(0, PG_MAX_DATNAME);
}
