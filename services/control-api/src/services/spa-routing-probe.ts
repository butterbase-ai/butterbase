// Post-deploy SPA routing probe.
//
// After deployUserWorker uploads the per-app static frontend worker, we hit a
// synthetic deep path on the live URL and assert the SPA fallback resolves to
// 200 + text/html. Catches any future regression of the html_handling 307 trap
// (PR #33) at the deploy boundary instead of via user complaint.
//
// The probe path is randomized so it cannot match any real route the user has
// shipped. If the worker's fallback is working, this returns the home
// document; if broken, it returns whatever the broken state produces
// (typically 307 to /, or 404).
//
// Retries: WfP dispatcher takes ~100-500ms to register a new script after
// upload. A small initial delay + 2 retries with backoff smooths over that
// race; failures past the retry budget are real routing failures.

import crypto from 'node:crypto';

export interface ProbeOptions {
  /** Initial delay before the first probe attempt. WfP dispatcher needs a beat to register the script. Default: 500ms. */
  probeDelayMs?: number;
  /** Number of retries on transient failure. Default: 2 (total 3 attempts). */
  retries?: number;
  /** Backoff between retries. Default: 500ms. */
  retryDelayMs?: number;
  /** Per-request timeout. Default: 5000ms. */
  timeoutMs?: number;
  /** Injectable for tests. Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export type ProbeResult =
  | { ok: true; status: number; contentType: string }
  | { ok: false; reason: string; code?: string; status?: number; contentType?: string | null };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Probe the SPA fallback by GETing a synthetic deep path and verifying the
 * worker resolves it to 200 + text/html (the index document). Returns a
 * result; never throws. Callers decide whether a failure aborts the deploy.
 */
export async function probeSpaRouting(
  deploymentUrl: string,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const probeDelayMs = options.probeDelayMs ?? 500;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  const probePath = `/__bb_route_probe_${crypto.randomBytes(8).toString('hex')}`;
  const url = deploymentUrl.replace(/\/+$/, '') + probePath;

  if (probeDelayMs > 0) await sleep(probeDelayMs);

  let lastResult: ProbeResult = { ok: false, reason: 'no attempts made' };

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs);
    lastResult = await singleAttempt(fetchImpl, url, timeoutMs);
    if (lastResult.ok) break;
  }
  if (!lastResult.ok) return lastResult;

  // Second probe: GET /index.html and assert 200 + text/html.
  // This catches "the worker can't find index.html at all" regardless of framework —
  // a universal sanity check that complements the random-deep-path SPA-fallback probe.
  const indexUrl = deploymentUrl.replace(/\/+$/, '') + '/index.html';
  let indexResult: ProbeResult = { ok: false, reason: 'no attempts made' };

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs);
    indexResult = await singleAttempt(fetchImpl, indexUrl, timeoutMs);
    if (indexResult.ok) break;
  }
  if (!indexResult.ok) {
    return {
      ok: false,
      code: 'INDEX_HTML_PROBE_FAILED',
      reason: indexResult.reason,
      status: indexResult.status,
      contentType: indexResult.contentType,
    };
  }

  return lastResult;
}

async function singleAttempt(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // redirect: 'manual' so a 307 → / is observed as a 307, not silently
    // followed (which would mask the exact bug this probe exists to detect).
    const res = await fetchImpl(url, { redirect: 'manual', signal: ac.signal });
    return evaluate(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `network error: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

function evaluate(res: Response): ProbeResult {
  const contentType = res.headers.get('content-type');

  if (res.status !== 200) {
    return {
      ok: false,
      reason: `expected status 200, got ${res.status}${
        res.status >= 300 && res.status < 400
          ? ` (Location: ${res.headers.get('location') ?? '<none>'})`
          : ''
      }`,
      status: res.status,
      contentType,
    };
  }
  if (!contentType || !contentType.toLowerCase().includes('text/html')) {
    return {
      ok: false,
      reason: `expected content-type text/html, got ${contentType ?? '<none>'}`,
      status: res.status,
      contentType,
    };
  }
  return { ok: true, status: res.status, contentType };
}
