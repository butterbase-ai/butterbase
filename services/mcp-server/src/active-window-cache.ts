/**
 * Process-wide cache for whether any hackathon is currently within its
 * submission window (starts_at … submission_deadline), as reported by
 * GET /v1/public/hackathons/active. That route does not filter on is_active;
 * it picks any row whose dates include "now", preferring is_active when
 * several overlap. Cache is refreshed by polling and invalidated on
 * `hackathon_active_changed` NOTIFY.
 */

import { getBaseUrl } from './api-client.js';

interface ActiveHackathon {
  starts_at: string;
  submission_deadline: string;
}

const POLL_INTERVAL_MS = 60_000; // refresh every 60 s as a safety net

let _active: boolean = false;
let _pollTimer: ReturnType<typeof setInterval> | null = null;

export async function fetchAndCacheActiveWindow(): Promise<boolean> {
  try {
    const res = await fetch(`${getBaseUrl()}/v1/public/hackathons/active`);
    if (res.status !== 200) {
      _active = false;
      return false;
    }
    const body = await res.json() as { hackathon?: ActiveHackathon };
    const h = body.hackathon;
    if (!h) {
      _active = false;
      return false;
    }
    const now = Date.now();
    _active = now >= new Date(h.starts_at).getTime()
           && now <= new Date(h.submission_deadline).getTime();
    return _active;
  } catch {
    _active = false;
    return false;
  }
}

/** Returns the cached active-window boolean (no network call). */
export function isActiveWindowCached(): boolean {
  return _active;
}

/** Invalidate the cache and immediately re-fetch. */
export async function invalidateActiveWindow(): Promise<void> {
  await fetchAndCacheActiveWindow();
}

/**
 * Start background polling so the cache stays warm.
 * Also does an immediate fetch to prime the cache.
 * Call once at server startup when CONTROL_API_URL / CONTROL_DB_URL is available.
 */
export function startActiveWindowPoller(): void {
  void fetchAndCacheActiveWindow();
  if (!_pollTimer) {
    _pollTimer = setInterval(() => {
      void fetchAndCacheActiveWindow();
    }, POLL_INTERVAL_MS);
    // Unref so the timer doesn't keep the process alive in tests.
    if (_pollTimer.unref) _pollTimer.unref();
  }
}
