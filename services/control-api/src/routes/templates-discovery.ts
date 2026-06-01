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
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  getConfiguredRuntimeRegions,
  fanOutRuntimeRegions,
  resolveAppHomeRegion,
} from '../services/region-resolver.js';
import { config } from '../config.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { introspectSchema } from '../services/schema-introspector.js';

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
  //   total is best-effort; clients should paginate until items.length < limit
  app.get('/v1/templates', {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
        keyGenerator: (req) => `ip:${req.ip}:templates-list`,
      },
    },
  }, async (request, reply) => {
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

    // Validate region filter: if provided but not a configured region, return empty page.
    // (A 400 would leak which regions exist; an empty page is the safe choice.)
    if (q.region !== undefined && !allRegions.includes(q.region)) {
      return reply.send({ items: [], total: 0, limit, offset });
    }

    // Over-fetch (limit + offset) from each region so that after merging we have
    // enough rows to paginate correctly without an unbounded COUNT query.
    const fetchLimit = limit + offset;

    let merged: TemplateRowWithoutOwner[];

    if (q.region) {
      // Single-region path — call getRuntimeDbPool once, no fan-out overhead.
      const pool = getRuntimeDbPool(config.runtimeDb, q.region);
      try {
        merged = await fetchRegionPublicApps(pool, q.region, q.q, sort, fetchLimit);
      } catch (err) {
        app.log.error({ err, region: q.region }, 'templates-discovery: single-region query failed');
        return reply.code(503).send({ error: { code: 'DISCOVERY_UNAVAILABLE' } });
      }
    } else {
      // All-region fan-out — degrade gracefully if individual regions fail.
      const regionResults: TemplateRowWithoutOwner[] = [];
      const regions = allRegions;

      const settled = await Promise.allSettled(
        regions.map(async (region) => {
          const pool = getRuntimeDbPool(config.runtimeDb, region);
          const rows = await fetchRegionPublicApps(pool, region, q.q, sort, fetchLimit);
          return { region, rows };
        }),
      );

      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          regionResults.push(...outcome.value.rows);
        } else {
          app.log.error(
            { err: outcome.reason },
            'templates-discovery: fan-out region query failed, skipping region',
          );
        }
      }

      merged = regionResults;
    }

    // Sort the merged results.
    const cmp =
      sort === 'popular'
        ? (a: TemplateRowWithoutOwner, b: TemplateRowWithoutOwner) =>
            b.fork_count - a.fork_count || b.created_at.localeCompare(a.created_at)
        : (a: TemplateRowWithoutOwner, b: TemplateRowWithoutOwner) =>
            b.created_at.localeCompare(a.created_at);

    merged.sort(cmp);

    // total is best-effort; bounded by (limit+offset) × regionCount, not unbounded COUNT.
    const total = merged.length;
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

  // GET /v1/templates/:app_id — anonymous detail endpoint for a single public+listed template.
  //
  // Returns 404 (TEMPLATE_NOT_FOUND) in all these cases to avoid existence leaks:
  //   - app doesn't exist
  //   - app exists but visibility !== 'public'
  //   - app exists but listed === false
  //
  // Response: app_id, name, region, owner_display_name, created_at (ISO),
  //   fork_count, has_repo, schema_summary, tables, functions, forks_sample (up to 5).
  app.get('/v1/templates/:app_id', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    // Resolve which region hosts this app. Throws AppNotFoundError if unknown.
    const region = await resolveAppHomeRegion(app.controlDb, app_id).catch(() => null);
    if (!region) {
      return reply.code(404).send({ error: { code: 'TEMPLATE_NOT_FOUND' } });
    }

    // Look up the app row and verify it is public + listed.
    const pool = getRuntimeDbPool(config.runtimeDb, region);
    const row = await pool.query<{
      id: string;
      name: string;
      owner_id: string;
      created_at: Date;
      fork_count: number;
      repo_latest_snapshot: string | null;
      visibility: string;
      listed: boolean;
    }>(
      `SELECT id, name, owner_id, created_at, fork_count, repo_latest_snapshot,
              visibility, listed
       FROM apps WHERE id = $1`,
      [app_id],
    );
    const r = row.rows[0];
    if (!r || r.visibility !== 'public' || !r.listed) {
      // No existence leak — same 404 for not-found, private, and unlisted.
      return reply.code(404).send({ error: { code: 'TEMPLATE_NOT_FOUND' } });
    }

    // Introspect user tables; degrade gracefully on failure.
    const schema = await introspectSchema(pool).catch((err) => {
      app.log.error({ err, app_id }, 'templates-discovery: introspectSchema failed, returning empty tables');
      return null;
    });
    const tables = schema
      ? Object.entries(schema.tables).map(([name, info]) => ({
          name,
          column_count: Object.keys(info.columns).length,
        }))
      : [];

    // Query functions; degrade gracefully on failure.
    const fnsResult = await pool
      .query<{ name: string; trigger_type: string }>(
        `SELECT name, trigger_type FROM app_functions
         WHERE app_id = $1 AND deleted_at IS NULL
         ORDER BY name`,
        [app_id],
      )
      .catch((err) => {
        app.log.error({ err, app_id }, 'templates-discovery: app_functions query failed, returning empty functions');
        return { rows: [] as Array<{ name: string; trigger_type: string }> };
      });
    const functions = fnsResult.rows;

    // Forks sample — cross-region fan-out, up to 5 most recent.
    const allRegions = getConfiguredRuntimeRegions();
    interface ForkCandidate {
      app_id: string;
      name: string;
      owner_id: string;
      created_at: string; // ISO
    }
    const forkCandidates: ForkCandidate[] = [];

    const forkSettled = await Promise.allSettled(
      allRegions.map(async (reg) => {
        const p = getRuntimeDbPool(config.runtimeDb, reg);
        const fr = await p.query<{ id: string; name: string; owner_id: string; created_at: Date }>(
          `SELECT id, name, owner_id, created_at FROM apps
           WHERE template_source_app_id = $1
           ORDER BY created_at DESC LIMIT 5`,
          [app_id],
        );
        return fr.rows.map((f) => ({
          app_id: f.id,
          name: f.name,
          owner_id: f.owner_id,
          created_at: f.created_at.toISOString(),
        }));
      }),
    );

    for (const outcome of forkSettled) {
      if (outcome.status === 'fulfilled') {
        forkCandidates.push(...outcome.value);
      } else {
        app.log.error(
          { err: outcome.reason, app_id },
          'templates-discovery: forks fan-out region query failed, skipping region',
        );
      }
    }

    // Sort newest first, take top 5 across all regions.
    forkCandidates.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const forks = forkCandidates.slice(0, 5);

    // Bulk-lookup owner display names (template owner + fork owners).
    const allOwnerIds = [r.owner_id, ...forks.map((f) => f.owner_id)];
    const names = await lookupOwnerNames(app.controlDb, allOwnerIds);

    return reply.send({
      app_id: r.id,
      name: r.name,
      region,
      owner_display_name: names.get(r.owner_id) ?? null,
      created_at: r.created_at.toISOString(),
      fork_count: r.fork_count,
      has_repo: r.repo_latest_snapshot !== null,
      schema_summary: { table_count: tables.length, function_count: functions.length },
      tables,
      functions,
      forks_sample: forks.map((f) => ({
        app_id: f.app_id,
        name: f.name,
        owner_display_name: names.get(f.owner_id) ?? null,
        created_at: f.created_at,
      })),
    });
  });
}
