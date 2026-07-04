import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Regression test for the multi-region home-region bug.
 *
 * The bug shape: a per-app query against the local machine's runtime DB pool.
 * Symptom: cross-region apps return 404 (or worse, writes land in the wrong
 * DB and stay invisible). Fix: resolve the app's home region from
 * org_app_index first, then pick the runtime pool — see
 * services/region-resolver.ts (resolveAppHomeRegion / getRuntimeDbForApp).
 *
 * This test scans the source tree for the lexical pattern that re-introduces
 * the bug and fails when it shows up outside of the small allow-list of
 * files that legitimately need the local instance region (per-region cron
 * queues, the resolver itself, platform-wide aggregations on admin routes).
 *
 * If you must add a new local-region runtime lookup, also add the file path
 * to ALLOW_LIST below with a comment explaining why.
 */

const SRC = path.resolve(__dirname, '..');

// Files that legitimately use the local instanceRegion against a runtime pool.
// Keep this list small and well-justified. Adding to it is OK; growing it
// without a per-region or platform-only justification is not.
const ALLOW_LIST = new Set<string>([
  // Resolver itself
  'services/region-resolver.ts',
  // Boot-time region config validation
  'index.ts',
  // Per-region cache, not per-app data; reconciled by state-outbox cron
  'plugins/quota-enforcement.ts',
  // neon_tasks + rag_ingestion_queue are per-region queues by design
  'services/neon-task-worker.ts',
  // Platform billing routes (subscriptions, invoices) are platform-tier
  'routes/billing.ts',
  // Platform partner admin / suggestions / proxy — not per-app
  'routes/partner-pools-admin.ts',
  'routes/partner-proxy.ts',
  'routes/suggestions.ts',
  // config.ts wires defaults; not a query path
  'config.ts',
  // edge-ssr-deployment / deployment.service / stripe-connect's webhook
  // handlers scan all regions to locate a per-deployment/connect-account
  // owner — they keep one assertRegionConfig() reference for fallbacks
  // that the audit explicitly preserved as 'us-east-1' defaults.
]);

async function listTsFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
      await listTsFiles(full, acc);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('multi-region: no instance-region runtime lookup', () => {
  it('does not reintroduce assertRegionConfig().instanceRegion + runtime pool for per-app queries', async () => {
    const files = await listTsFiles(SRC);
    const offenders: Array<{ file: string; lineNo: number; line: string }> = [];

    for (const file of files) {
      const rel = path.relative(SRC, file);
      if (ALLOW_LIST.has(rel)) continue;

      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      // We're looking for the literal pattern:
      //   const ... = assertRegionConfig().instanceRegion
      // co-located with a runtime DB call. The runtime DB call alone is fine
      // (e.g. cross-region fan-out); the combination is the regression.
      const hasInstanceRegion = text.includes('assertRegionConfig().instanceRegion');
      const hasRuntimeCall =
        /\b(app|fastify)\.runtimeDb\(region\)/.test(text) ||
        /getRuntimeDbPool\(\s*config\.runtimeDb\s*,\s*region\s*\)/.test(text);
      if (hasInstanceRegion && hasRuntimeCall) {
        // Find the lines for the diagnostic.
        lines.forEach((line, i) => {
          if (
            line.includes('assertRegionConfig().instanceRegion') ||
            /\b(app|fastify)\.runtimeDb\(region\)/.test(line) ||
            /getRuntimeDbPool\(\s*config\.runtimeDb\s*,\s*region\s*\)/.test(line)
          ) {
            offenders.push({ file: rel, lineNo: i + 1, line: line.trim() });
          }
        });
      }
    }

    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  ${o.file}:${o.lineNo}  ${o.line}`).join('\n');
      throw new Error(
        `Found ${offenders.length} sites combining local instanceRegion with a runtime DB call.\n` +
          `This is the multi-region bug: per-app queries must use getRuntimeDbForApp(controlPool, appId).\n` +
          `See services/region-resolver.ts.\n\n` +
          `Offending lines:\n${detail}`
      );
    }
    expect(offenders).toEqual([]);
  });
});
