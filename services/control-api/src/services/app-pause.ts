// services/control-api/src/services/app-pause.ts
//
// The single writer of apps.paused. Every pause and resume — the owner's
// PATCH /config/pause, the staging reaper, the idle reaper, the billing
// upgrade hook — goes through setPausedState so that the side effects that
// make a pause real (cache bust, frontend KV sync, deno-runtime cache,
// realtime teardown; added by later plans via onPauseStateChanged) can
// never be skipped by one caller.
//
// Side effects run after the UPDATE has returned, never inside a
// transaction, and never throw into the caller: a failed side effect is
// logged and the pause still stands.
//
// Listeners (onPauseStateChanged) are awaited sequentially by
// setPausedState, so their latency is on the caller's path (the owner's
// PATCH, the reaper loops) -- e.g. the frontend KV sync makes a few
// Cloudflare calls per key. They must never throw. Register them once at
// process startup, never per request.
//
// Spec: docs/superpowers/specs/2026-10-10-idle-free-app-pause-design.md §5.1

import type pg from 'pg';
import type { PausedBy } from './app-resolver.js';

export interface PausedState {
  app_id: string;
  paused: boolean;
  paused_at: string | null;
  paused_reason: string | null;
  paused_by: PausedBy | null;
}

export type PauseInput =
  | { paused: true; by: PausedBy; reason?: string | null }
  // idlePausePlan: the caller looked up the app's org and found it on a plan
  // the idle reaper targets. Such an org can't undo an idle pause for free;
  // upgrading is the way back (the upgrade hook resumes with by: 'system').
  | { paused: false; by: PausedBy | 'system'; idlePausePlan?: boolean; onlyIfPausedBy?: PausedBy };

/** An idle-reaper pause on a free plan; resuming requires an upgrade. */
export class ResumeRequiresUpgradeError extends Error {
  constructor(appId: string) {
    super(`App ${appId} was paused for inactivity; upgrade the plan to resume it`);
    this.name = 'ResumeRequiresUpgradeError';
  }
}

export interface PauseStateChange {
  appId: string;
  paused: boolean;
  by: PausedBy | 'system';
}

export interface PauseLogger {
  error(obj: unknown, msg?: string): void;
}

export type PauseStateListener = (change: PauseStateChange) => void | Promise<void>;

const listeners = new Set<PauseStateListener>();

export function onPauseStateChanged(listener: PauseStateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function notifyPauseStateChanged(change: PauseStateChange, log?: PauseLogger): Promise<void> {
  for (const listener of listeners) {
    try {
      await listener(change);
    } catch (err) {
      log?.error({ err, appId: change.appId, paused: change.paused }, '[app-pause] side effect failed');
    }
  }
}

const RETURNING = 'RETURNING id AS app_id, paused, paused_at, paused_reason, paused_by';

export async function setPausedState(
  runtimeDb: Pick<pg.Pool, 'query'>,
  appId: string,
  input: PauseInput,
  log?: PauseLogger,
): Promise<PausedState | null> {
  // Pause deliberately has no `WHERE paused = false`: re-pausing an already
  // paused app relabels paused_by (e.g. an admin pause over an idle pause
  // must not be auto-resumed on upgrade), while keeping the first paused_at.
  // The one exception: an owner pause over an idle-reaper pause keeps the
  // reaper's label and reason, or relabelling to 'owner' would let a free
  // owner resume without upgrading.
  const keepIdle = `paused AND paused_by = 'idle_reaper' AND $3 = 'owner'`;
  const idlePausePlan = !input.paused && input.idlePausePlan === true;
  const result = input.paused
    ? await runtimeDb.query(
        `UPDATE apps
            SET paused = true,
                paused_at = CASE WHEN paused THEN paused_at ELSE now() END,
                paused_reason = CASE WHEN ${keepIdle} THEN paused_reason ELSE $2 END,
                paused_by = CASE WHEN ${keepIdle} THEN paused_by ELSE $3 END,
                updated_at = now()
          WHERE id = $1
          ${RETURNING}`,
        [appId, input.reason ?? null, input.by],
      )
    : await runtimeDb.query(
        `UPDATE apps
            SET paused = false,
                paused_at = NULL,
                paused_reason = NULL,
                paused_by = NULL,
                last_active_at = now(),
                idle_warned_at = NULL,
                idle_pause_notified_at = NULL,
                updated_at = now()
          WHERE id = $1
            AND NOT ($2 AND paused_by IS NOT DISTINCT FROM 'idle_reaper')
            AND ($3::text IS NULL OR (paused AND paused_by = $3))
          ${RETURNING}`,
        [appId, idlePausePlan, input.onlyIfPausedBy ?? null],
      );

  if (result.rows.length === 0) {
    // The guard lives in the UPDATE so a concurrent reaper pause can't slip
    // past a separate read; only on a miss do we ask which case it was.
    if (idlePausePlan) {
      const exists = await runtimeDb.query('SELECT id FROM apps WHERE id = $1', [appId]);
      if (exists.rows.length > 0) throw new ResumeRequiresUpgradeError(appId);
    }
    return null;
  }
  await notifyPauseStateChanged({ appId, paused: input.paused, by: input.by }, log);
  return result.rows[0] as PausedState;
}
