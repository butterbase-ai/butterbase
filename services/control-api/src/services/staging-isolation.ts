import type pg from 'pg';

/**
 * Makes a freshly-provisioned staging app inert with respect to the outside
 * world.
 *
 * Secrets already do not travel — app-state-capture.ts omits OAuth client
 * secrets, composio_auth_config_id and byokKey by construction. What does
 * travel is the *rows* that say "this app is connected to that account", and
 * an enabled integration config. Left alone, a staging app can call a third
 * party with production's identity. Every statement is app_id-scoped and only
 * ever touches the staging app.
 *
 * Safe to re-run: both statements are idempotent (DELETE of an already-empty
 * set, UPDATE of already-disabled rows), so calling this again — e.g. from a
 * resumed clone pipeline or a later staging reset — cannot throw or double
 * side-effect.
 */
export async function isolateStagingApp(
  runtimeDb: pg.Pool, stagingAppId: string,
): Promise<{ clearedConnectedAccounts: number; disabledIntegrations: number }> {
  const cleared = await runtimeDb.query(
    `DELETE FROM app_connected_accounts WHERE app_id = $1`, [stagingAppId],
  );
  const disabled = await runtimeDb.query(
    `UPDATE app_integration_configs SET enabled = false WHERE app_id = $1`, [stagingAppId],
  );
  return {
    clearedConnectedAccounts: cleared.rowCount ?? 0,
    disabledIntegrations: disabled.rowCount ?? 0,
  };
}
