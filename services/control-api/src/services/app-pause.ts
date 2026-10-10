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
// Listeners (onPauseStateChanged) are awaited one at a time in the caller's
// path (the owner's PATCH, the reaper loops), so they must be fast or
// fire-and-forget internally. Register them once at process startup, never
// per request.
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
  | { paused: false; by: PausedBy | 'system' };

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
  // paused app must relabel paused_by (an owner pause over an idle pause
  // must not be auto-resumed on upgrade), while keeping the first paused_at.
  const result = input.paused
    ? await runtimeDb.query(
        `UPDATE apps
            SET paused = true,
                paused_at = CASE WHEN paused THEN paused_at ELSE now() END,
                paused_reason = $2,
                paused_by = $3,
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
                updated_at = now()
          WHERE id = $1
          ${RETURNING}`,
        [appId],
      );

  if (result.rows.length === 0) return null;
  await notifyPauseStateChanged({ appId, paused: input.paused, by: input.by }, log);
  return result.rows[0] as PausedState;
}
