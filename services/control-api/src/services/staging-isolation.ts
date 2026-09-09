import type pg from 'pg';

/**
 * Makes a freshly-provisioned staging app inert with respect to the outside
 * world.
 *
 * Secrets already do not travel — app-state-capture.ts omits OAuth client
 * secrets, composio_auth_config_id and byokKey by construction. What does
 * travel is the *rows* that say "this app is connected to that account", an
 * enabled integration config, and (per Ruling A) scheduled function triggers
 * that would otherwise start firing against the staging app's copy of
 * production data with no user action at all. Left alone, a staging app can
 * call a third party with production's identity on a timer nobody is
 * watching. Every statement is app_id-scoped and only ever touches the
 * staging app.
 *
 * Runtime-plane only: this function takes the runtime DB pool and never
 * touches the control-plane DB. `app_meetings_webhooks` lives in the control
 * plane and is handled separately by `isolateStagingMeetingsWebhook` below —
 * see that function's doc comment for why it is not folded in here.
 *
 * Safe to re-run: every statement is idempotent (DELETE of an already-empty
 * set, UPDATE of already-disabled rows), so calling this again — e.g. from a
 * resumed clone pipeline or a later staging reset — cannot throw or double
 * side-effect.
 */
export async function isolateStagingApp(
  runtimeDb: pg.Pool, stagingAppId: string,
): Promise<{
  clearedConnectedAccounts: number;
  disabledIntegrations: number;
  disabledCronTriggers: number;
}> {
  const cleared = await runtimeDb.query(
    `DELETE FROM app_connected_accounts WHERE app_id = $1`, [stagingAppId],
  );
  const disabled = await runtimeDb.query(
    `UPDATE app_integration_configs SET enabled = false WHERE app_id = $1`, [stagingAppId],
  );
  // Ruling A: function_triggers has a plain `enabled boolean` column (see
  // db/runtime-plane/001_initial_runtime_schema.sql), so disabling is a clean
  // UPDATE — no need to delete the trigger row. `trigger_type` is an
  // application-level enum (services/control-api/src/routes/functions.ts:
  // z.enum(['http', 'cron', 's3_upload', 'webhook', 'websocket'])), not a DB
  // CHECK constraint, but 'cron' is the literal value that enum uses, so it's
  // safe to match on directly rather than via a parameter.
  const disabledCron = await runtimeDb.query(
    `UPDATE function_triggers SET enabled = false WHERE app_id = $1 AND trigger_type = 'cron'`,
    [stagingAppId],
  );
  return {
    clearedConnectedAccounts: cleared.rowCount ?? 0,
    disabledIntegrations: disabled.rowCount ?? 0,
    disabledCronTriggers: disabledCron.rowCount ?? 0,
  };
}

/**
 * Ruling B: `app_meetings_webhooks` lives in the CONTROL-plane DB, not the
 * runtime DB `isolateStagingApp` operates on — deliberately kept as a
 * separate function taking a separate pool, rather than widening
 * `isolateStagingApp`'s signature to secretly also do control-DB work.
 *
 * `replayMeetingsWebhook` (clone-replay.ts) rewrites `forward_url` by
 * substituting sourceAppId -> destAppId. When the source's forward URL
 * follows the normal `/v1/{app_id}/fn/{name}` convention, that substitution
 * correctly repoints the row at the staging app's own function — genuinely
 * useful, and must be KEPT. When the URL doesn't contain the source app id
 * at all (an external host, or a custom domain), the substitution is a
 * no-op and the staging app is left pointing at production's real endpoint
 * with a freshly-minted signing secret still being delivered to it. This is
 * a direct test of "does this row target this app": if the current
 * `forward_url` contains `stagingAppId`, keep it; otherwise delete it.
 *
 * Safe to re-run: a missing row is a no-op, and re-checking an
 * already-verified self-referential row is a cheap SELECT + no-op.
 */
export async function isolateStagingMeetingsWebhook(
  controlDb: pg.Pool, stagingAppId: string,
): Promise<{ deleted: boolean }> {
  const row = await controlDb.query<{ forward_url: string }>(
    `SELECT forward_url FROM app_meetings_webhooks WHERE app_id = $1`,
    [stagingAppId],
  );
  if (row.rows.length === 0) {
    return { deleted: false };
  }
  if (row.rows[0].forward_url.includes(stagingAppId)) {
    // Self-referential after replay's rewrite — targets this staging app's
    // own function. Not an outbound risk; keep it.
    return { deleted: false };
  }
  const del = await controlDb.query(
    `DELETE FROM app_meetings_webhooks WHERE app_id = $1`, [stagingAppId],
  );
  return { deleted: (del.rowCount ?? 0) > 0 };
}
