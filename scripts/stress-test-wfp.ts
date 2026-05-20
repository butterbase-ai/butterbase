/**
 * Stress test for Cloudflare Workers for Platforms (WfP).
 *
 * Phases:
 *   1. Ensure dispatch namespace exists
 *   2. Upload N user workers (with static assets) in batches
 *   3. Hammer the workers with concurrent HTTP requests
 *   4. Collect latency / error metrics and print a report
 *   5. Optionally clean up
 *
 * Prerequisites:
 *   - Cloudflare account with Workers for Platforms enabled (Enterprise or contact CF)
 *   - A dispatch namespace created (or this script creates one)
 *   - A dispatch worker deployed that routes to the namespace (see README section below)
 *   - Environment variables or CLI flags for CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
 *
 * Usage:
 *   npx tsx scripts/stress-test-wfp.ts \
 *     --account-id <CF_ACCOUNT_ID> \
 *     --api-token <CF_API_TOKEN> \
 *     --namespace production \
 *     --dispatch-url https://your-dispatch-worker.workers.dev \
 *     --num-workers 50 \
 *     --requests-per-worker 20 \
 *     --concurrency 30 \
 *     --cleanup
 *
 *   # List all bb-stress-* user workers in the namespace and delete them (no stress run):
 *   npx tsx scripts/stress-test-wfp.ts --cleanup-only
 */

import crypto from 'node:crypto';

// ── CLI args / env ────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name: string, fallbackEnv?: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  if (fallbackEnv && process.env[fallbackEnv]) return process.env[fallbackEnv]!;
  return '';
}

function numFlag(name: string, fallback: number): number {
  const v = flag(name);
  return v ? parseInt(v, 10) : fallback;
}

const ACCOUNT_ID = flag('account-id', 'CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = flag('api-token', 'CLOUDFLARE_API_TOKEN');
const NAMESPACE = flag('namespace') || 'bb-stress-ns';
const DISPATCH_URL = flag('dispatch-url');
const NUM_WORKERS = numFlag('num-workers', 10);
const REQUESTS_PER_WORKER = numFlag('requests-per-worker', 10);
const CONCURRENCY = numFlag('concurrency', 20);
const DO_CLEANUP = args.includes('--cleanup');
const CLEANUP_ONLY = args.includes('--cleanup-only');
const SETTLE_MS = numFlag('settle-ms', 3000);

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error(
    'Missing credentials. Provide --account-id / --api-token flags or set CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN env vars.',
  );
  process.exit(1);
}

if (!DISPATCH_URL && !CLEANUP_ONLY) {
  console.error(
    'Missing --dispatch-url. This is the URL of your dispatch worker (e.g. https://bb-dispatch.your-subdomain.workers.dev).',
  );
  console.error('(Omit dispatch URL only when using --cleanup-only.)');
  process.exit(1);
}

// ── Cloudflare API helpers ────────────────────────────────────────────

const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
const headers: HeadersInit = {
  Authorization: `Bearer ${API_TOKEN}`,
  'Content-Type': 'application/json',
};

interface CfResult<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

async function cfFetch<T>(path: string, init?: RequestInit): Promise<CfResult<T>> {
  const url = path.startsWith('http') ? path : `${CF_BASE}${path}`;
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  const body = (await res.json()) as CfResult<T>;
  if (!body.success) {
    const msg = body.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ') ?? res.statusText;
    throw new Error(`CF API error (${res.status}): ${msg}`);
  }
  return body;
}

// ── Phase 1: Dispatch namespace ───────────────────────────────────────

async function ensureNamespace(): Promise<string> {
  console.log(`\n[Phase 1] Ensuring dispatch namespace "${NAMESPACE}" exists...`);
  try {
    const existing = await cfFetch<{ namespace_id: string }>(
      `/workers/dispatch/namespaces/${NAMESPACE}`,
    );
    console.log(`  Namespace exists (id: ${existing.result.namespace_id})`);
    return existing.result.namespace_id;
  } catch {
    console.log('  Namespace not found — creating...');
    const created = await cfFetch<{ namespace_id: string }>(`/workers/dispatch/namespaces`, {
      method: 'POST',
      body: JSON.stringify({ name: NAMESPACE }),
    });
    console.log(`  Created namespace (id: ${created.result.namespace_id})`);
    return created.result.namespace_id;
  }
}

// ── Phase 2: Upload user workers with static assets ───────────────────

function generateHtml(name: string, index: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Stress ${name}</title>
<style>body{font-family:system-ui;margin:2rem;background:#0d1117;color:#c9d1d9}
h1{color:#58a6ff}p{color:#8b949e}</style></head>
<body><h1>Worker ${index}</h1><p>Name: ${name}</p>
<p>Deployed: ${new Date().toISOString()}</p></body></html>`;
}

function generateWorkerJs(): string {
  return `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};`;
}

function sha256Hex32(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 32);
}

interface UploadResult {
  name: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

async function uploadWorker(name: string, index: number): Promise<UploadResult> {
  const t0 = performance.now();
  try {
    const htmlContent = generateHtml(name, index);
    const htmlBuf = Buffer.from(htmlContent, 'utf-8');
    const htmlHash = sha256Hex32(htmlBuf);

    const cssContent = `body{font-family:system-ui;margin:2rem;background:#0d1117;color:#c9d1d9}h1{color:#58a6ff}`;
    const cssBuf = Buffer.from(cssContent, 'utf-8');
    const cssHash = sha256Hex32(cssBuf);

    // Step 1: Create upload session
    const sessionRes = await cfFetch<{ jwt: string; buckets?: string[][] }>(
      `/workers/dispatch/namespaces/${NAMESPACE}/scripts/${name}/assets-upload-session`,
      {
        method: 'POST',
        body: JSON.stringify({
          manifest: {
            '/index.html': { hash: htmlHash, size: htmlBuf.length },
            '/styles.css': { hash: cssHash, size: cssBuf.length },
          },
        }),
      },
    );

    let completionToken = sessionRes.result.jwt;

    // Step 2: Upload file contents if buckets returned
    if (sessionRes.result.buckets && sessionRes.result.buckets.length > 0) {
      const hashToContent: Record<string, Buffer> = {
        [htmlHash]: htmlBuf,
        [cssHash]: cssBuf,
      };

      for (const bucket of sessionRes.result.buckets) {
        const formData = new FormData();
        for (const hash of bucket) {
          const content = hashToContent[hash];
          if (content) {
            formData.append(hash, content.toString('base64'));
          }
        }

        const uploadRes = await fetch(
          `${CF_BASE}/workers/assets/upload?base64=true`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${sessionRes.result.jwt}` },
            body: formData,
          },
        );
        const uploadBody = (await uploadRes.json()) as CfResult<{ jwt?: string }>;
        if (!uploadBody.success) {
          throw new Error(`Asset upload failed: ${JSON.stringify(uploadBody.errors)}`);
        }
        if (uploadBody.result.jwt) {
          completionToken = uploadBody.result.jwt;
        }
      }
    }

    // Step 3: Deploy user worker with assets
    const workerJs = generateWorkerJs();
    const metadata = JSON.stringify({
      main_module: 'worker.mjs',
      assets: {
        jwt: completionToken,
        config: { html_handling: 'auto-trailing-slash' },
      },
      compatibility_date: '2025-01-24',
    });

    const deployForm = new FormData();
    deployForm.append('metadata', new Blob([metadata], { type: 'application/json' }));
    deployForm.append(
      'worker.mjs',
      new Blob([workerJs], { type: 'application/javascript+module' }),
      'worker.mjs',
    );

    await fetch(
      `${CF_BASE}/workers/dispatch/namespaces/${NAMESPACE}/scripts/${name}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        body: deployForm,
      },
    ).then(async (r) => {
      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`Deploy failed (${r.status}): ${errText.slice(0, 300)}`);
      }
    });

    return { name, durationMs: performance.now() - t0, success: true };
  } catch (err) {
    return {
      name,
      durationMs: performance.now() - t0,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function uploadWorkers(): Promise<UploadResult[]> {
  console.log(`\n[Phase 2] Uploading ${NUM_WORKERS} user workers (concurrency=${CONCURRENCY})...`);
  const results: UploadResult[] = [];
  const names: string[] = [];

  for (let i = 0; i < NUM_WORKERS; i++) {
    names.push(`bb-stress-${i.toString().padStart(4, '0')}`);
  }

  // Process in batches
  for (let offset = 0; offset < names.length; offset += CONCURRENCY) {
    const batch = names.slice(offset, offset + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((name, j) => uploadWorker(name, offset + j)),
    );
    results.push(...batchResults);

    const ok = batchResults.filter((r) => r.success).length;
    const fail = batchResults.length - ok;
    console.log(
      `  Batch ${Math.floor(offset / CONCURRENCY) + 1}: ${ok} ok, ${fail} failed` +
        ` (avg ${Math.round(batchResults.reduce((s, r) => s + r.durationMs, 0) / batchResults.length)}ms)`,
    );

    // Log errors immediately so failures aren't hidden until the final report.
    const failures = batchResults.filter((r) => !r.success);
    if (failures.length > 0) {
      // Group by error message to avoid spamming when every worker hits the same issue.
      const byError = new Map<string, string[]>();
      for (const f of failures) {
        const key = f.error ?? 'unknown';
        if (!byError.has(key)) byError.set(key, []);
        byError.get(key)!.push(f.name);
      }
      for (const [err, names] of byError) {
        const sample = names.slice(0, 3).join(', ');
        const more = names.length > 3 ? ` (+${names.length - 3} more)` : '';
        console.log(`    ✗ ${names.length}× ${sample}${more}`);
        console.log(`      ${err}`);
      }
    }
  }

  return results;
}

// ── Phase 3: Hammer workers with requests ─────────────────────────────

interface RequestResult {
  workerName: string;
  path: string;
  status: number;
  latencyMs: number;
  error?: string;
}

async function hammerWorker(
  name: string,
  requestCount: number,
): Promise<RequestResult[]> {
  const results: RequestResult[] = [];
  const paths = ['/', '/health', '/index.html', '/styles.css'];

  for (let i = 0; i < requestCount; i++) {
    const p = paths[i % paths.length];
    const url = `${DISPATCH_URL}/${name}${p}`;
    const t0 = performance.now();
    try {
      const res = await fetch(url);
      await res.text(); // drain body
      results.push({
        workerName: name,
        path: p,
        status: res.status,
        latencyMs: performance.now() - t0,
      });
    } catch (err) {
      results.push({
        workerName: name,
        path: p,
        status: 0,
        latencyMs: performance.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

async function runLoadTest(workerNames: string[]): Promise<RequestResult[]> {
  const totalRequests = workerNames.length * REQUESTS_PER_WORKER;
  console.log(
    `\n[Phase 3] Sending ${totalRequests} requests across ${workerNames.length} workers (concurrency=${CONCURRENCY})...`,
  );

  const allResults: RequestResult[] = [];

  for (let offset = 0; offset < workerNames.length; offset += CONCURRENCY) {
    const batch = workerNames.slice(offset, offset + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((name) => hammerWorker(name, REQUESTS_PER_WORKER)),
    );

    for (const workerResults of batchResults) {
      allResults.push(...workerResults);
    }

    const flat = batchResults.flat();
    const okCount = flat.filter((r) => r.status >= 200 && r.status < 400).length;
    const avgMs = flat.reduce((s, r) => s + r.latencyMs, 0) / flat.length;
    console.log(
      `  Batch ${Math.floor(offset / CONCURRENCY) + 1}: ` +
        `${okCount}/${flat.length} success (avg ${Math.round(avgMs)}ms)`,
    );
  }

  return allResults;
}

// ── Phase 4: Report ───────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function printReport(
  uploadResults: UploadResult[],
  requestResults: RequestResult[],
) {
  console.log('\n' + '═'.repeat(70));
  console.log('  WORKERS FOR PLATFORMS STRESS TEST REPORT');
  console.log('═'.repeat(70));

  // Upload stats
  const uploadOk = uploadResults.filter((r) => r.success);
  const uploadFail = uploadResults.filter((r) => !r.success);
  const uploadTimes = uploadOk.map((r) => r.durationMs).sort((a, b) => a - b);

  console.log('\n── Upload Phase ──');
  console.log(`  Total workers:   ${uploadResults.length}`);
  console.log(`  Successful:      ${uploadOk.length}`);
  console.log(`  Failed:          ${uploadFail.length}`);
  if (uploadTimes.length > 0) {
    console.log(`  Avg deploy time: ${Math.round(uploadTimes.reduce((a, b) => a + b, 0) / uploadTimes.length)}ms`);
    console.log(`  p50:             ${Math.round(percentile(uploadTimes, 50))}ms`);
    console.log(`  p95:             ${Math.round(percentile(uploadTimes, 95))}ms`);
    console.log(`  p99:             ${Math.round(percentile(uploadTimes, 99))}ms`);
    console.log(`  Max:             ${Math.round(uploadTimes[uploadTimes.length - 1])}ms`);
  }

  if (uploadFail.length > 0) {
    console.log('\n  Failed uploads:');
    for (const f of uploadFail.slice(0, 10)) {
      console.log(`    ${f.name}: ${f.error}`);
    }
    if (uploadFail.length > 10) console.log(`    ... and ${uploadFail.length - 10} more`);
  }

  // Request stats
  const byStatus: Record<number, number> = {};
  const latencies = requestResults.map((r) => r.latencyMs).sort((a, b) => a - b);
  const errors = requestResults.filter((r) => r.status === 0 || r.status >= 400);

  for (const r of requestResults) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }

  console.log('\n── Load Test Phase ──');
  console.log(`  Total requests:  ${requestResults.length}`);
  console.log(`  Status codes:`);
  for (const [code, count] of Object.entries(byStatus).sort()) {
    const pct = ((count / requestResults.length) * 100).toFixed(1);
    console.log(`    ${code === '0' ? 'ERR' : code}: ${count} (${pct}%)`);
  }
  if (latencies.length > 0) {
    console.log(`  Avg latency:     ${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)}ms`);
    console.log(`  p50:             ${Math.round(percentile(latencies, 50))}ms`);
    console.log(`  p95:             ${Math.round(percentile(latencies, 95))}ms`);
    console.log(`  p99:             ${Math.round(percentile(latencies, 99))}ms`);
    console.log(`  Max:             ${Math.round(latencies[latencies.length - 1])}ms`);
  }

  // Per-path breakdown
  const byPath: Record<string, number[]> = {};
  for (const r of requestResults) {
    if (!byPath[r.path]) byPath[r.path] = [];
    byPath[r.path].push(r.latencyMs);
  }
  console.log('\n  Per-path avg latency:');
  for (const [p, times] of Object.entries(byPath)) {
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    console.log(`    ${p.padEnd(20)} ${avg}ms`);
  }

  if (errors.length > 0) {
    console.log(`\n  Errors (${errors.length} total):`);
    const sample = errors.slice(0, 5);
    for (const e of sample) {
      console.log(`    ${e.workerName}${e.path} → ${e.status || 'NETWORK_ERR'}: ${e.error ?? ''}`);
    }
    if (errors.length > 5) console.log(`    ... and ${errors.length - 5} more`);
  }

  console.log('\n' + '═'.repeat(70));
}

// ── Phase 5: Cleanup (list all bb-stress-* in namespace, then delete) ─

interface DispatchScriptRow {
  id: string;
  script_name?: string;
  created_on?: string;
}

interface DispatchScriptsListResponse {
  success: boolean;
  result: DispatchScriptRow[];
  result_info?: { page: number; total_pages: number; count?: number; total_count?: number };
  errors?: { code: number; message: string }[];
}

/** Paginate dispatch namespace scripts and return names matching bb-stress-*. */
async function listBbStressWorkersInNamespace(): Promise<string[]> {
  const names: string[] = [];
  let page = 1;

  while (true) {
    const url = `${CF_BASE}/workers/dispatch/namespaces/${encodeURIComponent(NAMESPACE)}/scripts?page=${page}&per_page=100`;
    const res = await fetch(url, { headers });
    const data = (await res.json()) as DispatchScriptsListResponse;

    if (!data.success || !Array.isArray(data.result)) {
      if (data.errors?.some((e) => e.code === 10092 || e.message.toLowerCase().includes('not found'))) {
        console.log(`  Namespace "${NAMESPACE}" not found or empty.`);
        return [];
      }
      const msg = data.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ') ?? res.statusText;
      throw new Error(`List scripts failed (${res.status}): ${msg}`);
    }

    for (const row of data.result) {
      const name = row.script_name ?? row.id;
      if (name.startsWith('bb-stress-')) names.push(name);
    }

    const totalPages = data.result_info?.total_pages ?? 1;
    if (page >= totalPages) break;
    page++;
  }

  return names;
}

async function deleteOneBbStressWorker(name: string): Promise<boolean> {
  const url = `${CF_BASE}/workers/dispatch/namespaces/${encodeURIComponent(NAMESPACE)}/scripts/${encodeURIComponent(name)}`;
  try {
    const res = await fetch(url, { method: 'DELETE', headers });
    if (res.ok || res.status === 404) return true;
    const body = await res.text();
    console.error(`  Failed to delete ${name} (${res.status}): ${body.slice(0, 200)}`);
    return false;
  } catch (err) {
    console.error(`  Network error deleting ${name}: ${err}`);
    return false;
  }
}

/** List every bb-stress-* script in the dispatch namespace, then delete each. */
async function deleteAllBbStressWorkers(): Promise<void> {
  console.log(`\n[Phase 5] Listing bb-stress-* scripts in namespace "${NAMESPACE}"...`);
  const names = await listBbStressWorkersInNamespace();
  console.log(`  Found ${names.length} matching worker(s).`);

  if (names.length === 0) {
    console.log('  Nothing to delete.');
    return;
  }

  const preview = names.length <= 15 ? names : [...names.slice(0, 10), `… +${names.length - 10} more`];
  for (const n of preview) {
    console.log(`    - ${n}`);
  }

  console.log(`\n[Phase 5] Deleting ${names.length} worker(s) (concurrency=${CONCURRENCY})...`);
  let deleted = 0;

  for (let offset = 0; offset < names.length; offset += CONCURRENCY) {
    const batch = names.slice(offset, offset + CONCURRENCY);
    const results = await Promise.all(batch.map((name) => deleteOneBbStressWorker(name)));
    const ok = results.filter(Boolean).length;
    deleted += ok;
    console.log(
      `  Batch ${Math.floor(offset / CONCURRENCY) + 1}: ${ok}/${batch.length} deleted`,
    );
  }

  console.log(`\n  Done. Removed ${deleted}/${names.length} bb-stress-* worker(s).`);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     Cloudflare Workers for Platforms — Stress Test                  ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`  Account:       ${ACCOUNT_ID.slice(0, 8)}...`);
  console.log(`  Namespace:     ${NAMESPACE}`);
  console.log(`  Dispatch URL:  ${DISPATCH_URL || '(not used in cleanup-only)'}`);
  console.log(`  Workers:       ${NUM_WORKERS}`);
  console.log(`  Reqs/worker:   ${REQUESTS_PER_WORKER}`);
  console.log(`  Concurrency:   ${CONCURRENCY}`);
  console.log(`  Cleanup:       ${DO_CLEANUP}`);
  console.log(`  Cleanup-only:  ${CLEANUP_ONLY}`);

  const t0 = performance.now();

  if (CLEANUP_ONLY) {
    await deleteAllBbStressWorkers();
    console.log(`\nTotal elapsed: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  // Phase 1
  await ensureNamespace();

  // Phase 2
  const uploadResults = await uploadWorkers();
  const successfulNames = uploadResults.filter((r) => r.success).map((r) => r.name);

  if (successfulNames.length === 0) {
    console.error('\nNo workers deployed successfully.');
    if (DO_CLEANUP) {
      console.log('--cleanup: listing and deleting all bb-stress-* workers in the namespace anyway.');
      await deleteAllBbStressWorkers();
    }
    process.exit(1);
  }

  // Settle time for propagation
  console.log(`\n  Waiting ${SETTLE_MS}ms for edge propagation...`);
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  // Print URLs for manual navigation
  console.log(`\n── Deployed pages (${successfulNames.length}) ──`);
  for (const name of successfulNames) {
    console.log(`  ${DISPATCH_URL}/${name}/`);
  }

  // Summary for any uploads that failed
  const uploadFail = uploadResults.filter((r) => !r.success);
  if (uploadFail.length > 0) {
    console.log(`\n  ${uploadFail.length} upload(s) failed — see per-batch errors above.`);
  }

  // Cleanup (opt-in): list every bb-stress-* in the namespace from the API, then delete all
  if (DO_CLEANUP) {
    console.log('\n  --cleanup: listing all bb-stress-* scripts in the namespace, then deleting each.');
    await deleteAllBbStressWorkers();
  } else {
    console.log('\n  Tip: Run with --cleanup to delete all bb-stress-* workers in this namespace, or:');
    console.log('    npx tsx scripts/stress-test-wfp.ts --cleanup-only --namespace ' + NAMESPACE);
    console.log('    npx tsx scripts/cleanup-wfp-stress.ts --namespace ' + NAMESPACE);
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\nTotal elapsed: ${elapsed}s`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
