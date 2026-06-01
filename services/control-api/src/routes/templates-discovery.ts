// Anonymous-readable template discovery — fans out across all runtime regions
// to assemble the public+listed app catalog. See spec
// docs/superpowers/specs/2026-05-31-app-templates-and-repo-sync-design.md
// section "Discovery API + Dashboard UI".
//
// NOTE: fork_count is maintained by an intra-region trigger on insert/update/delete
// of template_source_app_id (runtime migration 014_app_visibility.sql). Cross-region
// clones will miss the increment until a control-plane outbox sweeper is wired up
// (out of scope for Phase 4bcd — tracked as a known gap).
//
// NOTE: Rate limiting (60 req/min per IP) is not yet wired to this endpoint.
// @fastify/rate-limit is already in package.json; adding the limit is deferred
// to a follow-up task to avoid non-trivial infra setup.

import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  getConfiguredRuntimeRegions,
  fanOutRuntimeRegions,
} from '../services/region-resolver.js';

interface TemplateRow {
  app_id: string;
  name: string;
  region: string;
  owner_id: string;
  owner_display_name: string | null;
  created_at: string; // ISO
  fork_count: number;
  has_repo: boolean;
  schema_summary: { table_count: number; function_count: number };
}

type TemplateRowWithoutOwner = Omit<TemplateRow, 'owner_display_name'>;

async function fetchRegionPublicApps(
  pool: pg.Pool,
  region: string,
  q: string | undefined,
  sort: 'recent' | 'popular',
  fetchLimit: number,
): Promise<TemplateRowWithoutOwner[]> {
  const orderBy =
    sort === 'popular' ? 'fork_count DESC, created_at DESC' : 'created_at DESC';

  const params: unknown[] = [];
  let where = `visibility = 'public' AND listed = true AND db_provisioned = true`;
  if (q) {
    params.push(`${q}%`);
    where += ` AND name ILIKE $${params.length}`;
  }
  params.push(fetchLimit);
  const limitParam = `$${params.length}`;

  const res = await pool.query<{
    id: string;
    name: string;
    owner_id: string;
    created_at: Date;
    fork_count: number;
    repo_latest_snapshot: string | null;
  }>(
    `SELECT id, name, owner_id, created_at, fork_count, repo_latest_snapshot
     FROM apps
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT ${limitParam}`,
    params,
  );

  return res.rows.map((r) => ({
    app_id: r.id,
    name: r.name,
    region,
    owner_id: r.owner_id,
    created_at: r.created_at.toISOString(),
    fork_count: r.fork_count,
    has_repo: r.repo_latest_snapshot !== null,
    // Schema summary is omitted on list view (would require per-app DB round-trip).
    // The detail endpoint (Task 3) returns actual table/function counts.
    schema_summary: { table_count: 0, function_count: 0 },
  }));
}

async function lookupOwnerNames(
  controlDb: pg.Pool,
  ownerIds: string[],
): Promise<Map<string, string | null>> {
  if (ownerIds.length === 0) return new Map();
  const unique = Array.from(new Set(ownerIds));
  const res = await controlDb.query<{ id: string; display_name: string | null }>(
    `SELECT id, display_name FROM platform_users WHERE id = ANY($1)`,
    [unique],
  );
  const m = new Map<string, string | null>();
  for (const r of res.rows) m.set(r.id, r.display_name);
  return m;
}

export function templatesDiscoveryRoutes(app: FastifyInstance) {
  // GET /v1/templates — anonymous, cross-region aggregated list of public templates.
  //
  // Query params:
  //   q        — ILIKE prefix filter on app name (optional)
  //   region   — restrict to a single region slug (optional; omit = all regions)
  //   sort     — "recent" (default) | "popular" (by fork_count desc)
  //   limit    — 1–50, default 20
  //   offset   — >= 0, default 0
  //
  // Response:
  //   { items: TemplateRow[], total: number, limit: number, offset: number }
  //   total is approximate (bounded by limit+offset per region, not unbounded COUNT).
  app.get('/v1/templates', async (request, reply) => {
    const q = request.query as {
      q?: string;
      region?: string;
      sort?: string;
      limit?: string;
      offset?: string;
    };

    const sort: 'recent' | 'popular' = q.sort === 'popular' ? 'popular' : 'recent';
    const limit = Math.min(Math.max(parseInt(q.limit ?? '20', 10) || 20, 1), 50);
    const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);

    // Determine which regions to query.
    const allRegions = getConfiguredRuntimeRegions();
    const targetRegions =
      q.region && allRegions.includes(q.region) ? [q.region] : allRegions;

    // Over-fetch (limit + offset) from each region so that after merging we have
    // enough rows to paginate correctly without an unbounded COUNT query.
    const fetchLimit = limit + offset;

    let merged: TemplateRowWithoutOwner[];

    if (q.region && allRegions.includes(q.region)) {
      // Single-region path — use fanOutRuntimeRegions with filter.
      const results = await fanOutRuntimeRegions(async (pool, region) => {
        if (region !== q.region) return [];
        return fetchRegionPublicApps(pool, region, q.q, sort, fetchLimit);
      });
      merged = results.flatMap((r) => r.result);
    } else {
      // All-region fan-out.
      const results = await fanOutRuntimeRegions(async (pool, region) =>
        fetchRegionPublicApps(pool, region, q.q, sort, fetchLimit),
      );
      merged = results.flatMap((r) => r.result);
    }

    // Sort the merged results.
    const cmp =
      sort === 'popular'
        ? (a: TemplateRowWithoutOwner, b: TemplateRowWithoutOwner) =>
            b.fork_count - a.fork_count || b.created_at.localeCompare(a.created_at)
        : (a: TemplateRowWithoutOwner, b: TemplateRowWithoutOwner) =>
            b.created_at.localeCompare(a.created_at);

    merged.sort(cmp);

    const total = merged.length; // approximate — bounded by (limit+offset) × regionCount
    const page = merged.slice(offset, offset + limit);

    // Enrich with owner display names from the control-plane platform_users table.
    const names = await lookupOwnerNames(
      app.controlDb,
      page.map((p) => p.owner_id),
    );

    const items: TemplateRow[] = page.map((p) => ({
      ...p,
      owner_display_name: names.get(p.owner_id) ?? null,
    }));

    return reply.send({ items, total, limit, offset });
  });
}
