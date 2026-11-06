// services/control-api/src/__tests__/pause-gate-coverage.test.ts
//
// Drift guard for the pause gate. Every route path with an app-id param is
// either covered by the gate (has :appId/:app_id, not under a skip prefix)
// or listed below with the reason it's safe. Fails when someone adds an
// app-scoped route the gate can't see.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGateSkipped } from '../plugins/pause-gate.js';

const ROUTES_DIR = fileURLToPath(new URL('../routes', import.meta.url));

// path → why it's safe without the gate
const ALLOWLIST: Record<string, string> = {
  // Template discovery/clone: a paused template must stay listable and cloneable (spec §5.2).
  // These return template metadata/releases or copy a public template, not the app's live data or code.
  '/v1/templates/:source_app_id/clone-intent': 'template clone flow; paused templates stay cloneable',
  '/v1/templates/:source_app_id/clone-preflight': 'template clone flow; paused templates stay cloneable',
  '/v1/templates/:source_app_id/clone': 'template clone flow; paused templates stay cloneable',
  '/v1/templates/:app_id/releases': 'anonymous template changelog; paused templates stay listable',
  '/v1/templates/:app_id/releases/:n': 'anonymous template release detail; paused templates stay listable',
  '/v1/templates/:app_id': 'anonymous public+listed template detail; paused templates stay listable',
  // Internal KV credential routes: internal-auth plugin requires the shared service secret on every
  // /v1/internal/* path, so no tenant or end user can reach them. KV traffic itself is gated at /v1/:appId/kv.
  '/v1/internal/kv/credentials/:app_id': 'internal-auth shared secret on all /v1/internal/*; service-to-service only',
  '/v1/internal/kv/anon-credentials/:app_id': 'internal-auth shared secret on all /v1/internal/*; service-to-service only',
  '/v1/internal/kv/function-credentials/:app_id': 'internal-auth shared secret on all /v1/internal/*; service-to-service only',
  '/v1/internal/kv/credentials/:app_id/rotate': 'internal-auth shared secret on all /v1/internal/*; service-to-service only',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : walk(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

const ROUTE_RE = /\.(?:get|post|put|patch|delete|all|route)\s*(?:<[^>]*>)?\(\s*['`]([^'`]+)['`]/g;

function routePaths(): string[] {
  const out = new Set<string>();
  for (const file of walk(ROUTES_DIR)) {
    for (const m of readFileSync(file, 'utf8').matchAll(ROUTE_RE)) out.add(m[1]);
  }
  return [...out];
}

describe('pause gate coverage', () => {
  it('finds routes (sanity)', () => {
    const paths = routePaths();
    expect(paths.length).toBeGreaterThan(100);
    for (const known of ['/v1/:appId/webhook/:functionName', '/v1/:app_id/fn/:functionName']) {
      expect(paths, `expected to find ${known}`).toContain(known);
    }
    expect(paths.some((p) => p.startsWith('/storage/:appId/'))).toBe(true);
  });

  it('every app-scoped route is gated or allowlisted with a reason', () => {
    const uncovered = routePaths().filter((p) => {
      const hasAppParam = /:(appId|app_id)\b/.test(p);
      const hasSourceParam = /:source_app_id\b/.test(p);
      if (!hasAppParam && !hasSourceParam) return false;
      if (hasAppParam && !isGateSkipped(p)) return false; // gated
      return !(p in ALLOWLIST);
    });
    expect(uncovered).toEqual([]);
  });

  it('allowlist entries still exist and have reasons', () => {
    const paths = new Set(routePaths());
    for (const [p, why] of Object.entries(ALLOWLIST)) {
      expect(paths.has(p), `stale allowlist entry ${p}`).toBe(true);
      expect(why.length).toBeGreaterThan(10);
    }
  });
});
