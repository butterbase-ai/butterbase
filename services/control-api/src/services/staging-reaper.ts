// services/control-api/src/services/staging-reaper.ts
//
// Staging environments are idle by definition — nobody expects a staging app
// to serve steady traffic the way its production sibling does. But an
// abandoned staging app still holds a Neon project, so this pauses (never
// deletes) staging apps with no activity for BUTTERBASE_STAGING_IDLE_DAYS
// days (default 30). Deletion stays a manual, human decision; apps.paused is
// the existing kill-switch column (043_app_paused.sql / confirmed present in
// db/runtime-plane/001_initial_runtime_schema.sql), so no migration is
// needed for this task.
//
// Safety: every statement here is scoped through app_environments so it can
// only ever touch a row that is actually somebody's staging_app_id. A bug
// that paused a production app would take a customer's live site offline —
// see runOnce's UPDATE, which re-derives the staging id set from
// app_environments rather than trusting the id list alone.
//
// Shape follows fork-count-sweeper.ts: a recursive setTimeout tick (not
// setInterval) so a slow sweep can't overlap the next one, an unref'd timer
// so it never keeps the process alive on its own, and a stop handle for
// graceful shutdown.

import type pg from 'pg';

const DEFAULT_IDLE_DAYS = 30;
const INTERVAL_MS = 6 * 60 * 60 * 1000; // four times a day is plenty for a days-scale threshold

export interface ReaperLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export function idleDaysFromEnv(): number {
  const raw = process.env.BUTTERBASE_STAGING_IDLE_DAYS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_DAYS;
}

/**
 * Staging apps idle beyond idleDays: not paused already, and quiet on both
 * signals we have for "somebody is using this" — the app row itself
 * (updated_at, which bumps on config/deploy/etc. changes) and the
 * environment link (last_reset_at, or created_at if it has never been
 * reset). Both conditions are scoped through app_environments.staging_app_id
 * — this query can only ever name ids that are somebody's staging app.
 */
export async function findIdleStagingApps(
  runtimeDb: pg.Pool,
  idleDays: number,
): Promise<string[]> {
  const res = await runtimeDb.query<{ staging_app_id: string }>(
    `SELECT e.staging_app_id
       FROM app_environments e
       JOIN apps a ON a.id = e.staging_app_id
      WHERE a.paused = false
        AND a.updated_at < now() - ($1 || ' days')::interval
        AND COALESCE(e.last_reset_at, e.created_at) < now() - ($1 || ' days')::interval`,
    [idleDays],
  );
  return res.rows.map((r) => r.staging_app_id);
}

/**
 * Pauses, never deletes. A paused staging app keeps its Neon project and can
 * be resumed; deleting one is a destructive act that stays a human decision.
 *
 * The UPDATE is scoped through app_environments.staging_app_id — even if the
 * id list passed in were somehow wrong, the `id IN (SELECT staging_app_id
 * FROM app_environments)` clause means this statement can never pause a row
 * that isn't a staging app. That is what makes a bug in the id list unable to
 * take a production app offline.
 */
export async function runOnce(
  runtimeDb: pg.Pool,
  idleDays: number,
  logger: ReaperLogger,
): Promise<{ paused: number }> {
  const ids = await findIdleStagingApps(runtimeDb, idleDays);
  if (ids.length === 0) return { paused: 0 };

  const res = await runtimeDb.query(
    `UPDATE apps SET paused = true, updated_at = now()
      WHERE id = ANY($1)
        AND id IN (SELECT staging_app_id FROM app_environments)`,
    [ids],
  );
  logger.info({ paused: res.rowCount, ids }, '[staging-reaper] paused idle staging apps');
  return { paused: res.rowCount ?? 0 };
}

export function startStagingReaper(
  runtimeDb: pg.Pool,
  logger: ReaperLogger,
  intervalMs: number = INTERVAL_MS,
): () => void {
  const idleDays = idleDaysFromEnv();
  let running = true;
  let currentTimer: ReturnType<typeof setTimeout> | null = null;
  let activeRun: Promise<void> | null = null;

  async function tick(): Promise<void> {
    if (!running) return;
    try {
      await runOnce(runtimeDb, idleDays, logger);
    } catch (err) {
      logger.error({ err }, '[staging-reaper] sweep failed');
    } finally {
      if (running) {
        currentTimer = setTimeout(() => {
          activeRun = tick();
        }, intervalMs);
        currentTimer.unref();
      }
    }
  }

  logger.info({ intervalMs, idleDays }, '[staging-reaper] started');
  activeRun = tick();

  return function stop(): void {
    running = false;
    if (currentTimer !== null) clearTimeout(currentTimer);
    void activeRun;
    logger.info({}, '[staging-reaper] stopped');
  };
}
