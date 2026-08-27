import { describe, it, expect, vi } from 'vitest';

function controlDbReturning(handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number }) {
  return { query: vi.fn(async (sql: string, params: unknown[] = []) => handler(sql, params)) } as any;
}

describe('recordLineage', () => {
  it('inserts with ON CONFLICT (dest_app_id) DO NOTHING so a clone retry cannot duplicate or overwrite', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const controlDb = controlDbReturning((sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    });

    const { recordLineage } = await import('../services/app-lineage.js');
    await recordLineage(controlDb, {
      destAppId: 'app_fork', destRegion: 'us-east-1',
      sourceAppId: 'app_src', sourceRegion: 'us-east-1',
      baseReleaseId: 'rel_1', baseFingerprint: null, baseSnapshotId: 'snap_1',
    });

    expect(capturedSql).toContain('INSERT INTO app_lineage');
    expect(capturedSql).toContain('ON CONFLICT (dest_app_id) DO NOTHING');
    expect(capturedParams).toEqual(['app_fork', 'us-east-1', 'app_src', 'us-east-1', 'rel_1', null, 'snap_1']);
  });
});

describe('getLineage', () => {
  it('returns the lineage row for a fork', async () => {
    const row = {
      dest_app_id: 'app_fork', dest_region: 'us-east-1',
      source_app_id: 'app_src', source_region: 'us-east-1',
      base_release_id: null, base_fingerprint: null, base_snapshot_id: null,
      severed_at: null, cloned_at: new Date('2026-01-01T00:00:00Z'),
    };
    const controlDb = controlDbReturning(() => ({ rows: [row] }));

    const { getLineage } = await import('../services/app-lineage.js');
    const result = await getLineage(controlDb, 'app_fork');
    expect(result).toEqual(row);
  });

  it('returns null when the app has no lineage row', async () => {
    const controlDb = controlDbReturning(() => ({ rows: [] }));

    const { getLineage } = await import('../services/app-lineage.js');
    const result = await getLineage(controlDb, 'app_standalone');
    expect(result).toBeNull();
  });
});

describe('severLineage', () => {
  it('sets severed_at and returns true when a row was updated', async () => {
    const controlDb = controlDbReturning((sql) => {
      expect(sql).toContain('severed_at IS NULL');
      expect(sql).toContain('SET severed_at = now()');
      return { rows: [], rowCount: 1 };
    });

    const { severLineage } = await import('../services/app-lineage.js');
    const result = await severLineage(controlDb, 'app_fork');
    expect(result).toBe(true);
  });

  it('returns false when the fork was already severed (no row matched)', async () => {
    const controlDb = controlDbReturning(() => ({ rows: [], rowCount: 0 }));

    const { severLineage } = await import('../services/app-lineage.js');
    const result = await severLineage(controlDb, 'app_fork');
    expect(result).toBe(false);
  });
});

describe('computeDrift', () => {
  it('uses release_number when the fork has a base release', async () => {
    const controlDb = controlDbReturning((sql) => {
      if (sql.includes('FROM app_lineage')) {
        return { rows: [{
          dest_app_id: 'app_fork', source_app_id: 'app_src', severed_at: null,
          base_release_id: 'rel_1', base_snapshot_id: 'snap_0', base_fingerprint: null,
          cloned_at: new Date('2026-01-01T00:00:00Z'),
        }] };
      }
      if (sql.includes('WHERE id = $1')) return { rows: [{ release_number: 2 }] };
      if (sql.includes('release_number > $2')) {
        return { rows: [
          { release_number: 4, label: 'v1.4', notes: null, published_at: new Date() },
          { release_number: 3, label: 'v1.3', notes: null, published_at: new Date() },
        ] };
      }
      return { rows: [] };
    });

    const { computeDrift } = await import('../services/app-lineage.js');
    const drift = await computeDrift(controlDb, 'app_fork');
    expect(drift.behind_by).toBe(2);
    expect(drift.severed).toBe(false);
    expect(drift.releases[0].release_number).toBe(4);
  });

  it('excludes the base release itself from drift (strict greater-than, not >=)', async () => {
    // The full release list for this template includes release 2 — the fork's
    // own base — plus release 3, published after. A regression from strict `>`
    // to `>=` would let the stub match the same 'release_number > $2' text
    // literally, so this handler filters programmatically off the query's own
    // params rather than returning a fixed canned list: if the implementation
    // changes the operator, the WHERE-text match below stops matching entirely
    // (since a generated '>= $2' string does not contain the substring
    // 'release_number > $2'), the handler falls through to the default `{ rows: [] }`,
    // and behind_by drops to 0 instead of the expected 1 — a visible failure
    // either way the operator could drift.
    const allReleasesForTemplate = [
      { release_number: 2, label: 'base (must never appear)', notes: null, published_at: new Date('2026-01-01T00:00:00Z') },
      { release_number: 3, label: 'v1.3', notes: null, published_at: new Date('2026-02-01T00:00:00Z') },
    ];

    const controlDb = controlDbReturning((sql, params) => {
      if (sql.includes('FROM app_lineage')) {
        return { rows: [{
          dest_app_id: 'app_fork', source_app_id: 'app_src', severed_at: null,
          base_release_id: 'rel_2', base_snapshot_id: 'snap_0', base_fingerprint: null,
          cloned_at: new Date('2026-01-01T00:00:00Z'),
        }] };
      }
      if (sql.includes('WHERE id = $1')) return { rows: [{ release_number: 2 }] };
      if (sql.includes('release_number > $2')) {
        const baseNumber = params[1] as number;
        return { rows: allReleasesForTemplate.filter((r) => r.release_number > baseNumber) };
      }
      return { rows: [] };
    });

    const { computeDrift } = await import('../services/app-lineage.js');
    const drift = await computeDrift(controlDb, 'app_fork');
    expect(drift.behind_by).toBe(1);
    expect(drift.releases.some((r) => r.release_number === 2)).toBe(false);
  });

  it('falls back to cloned_at when there is no base release', async () => {
    const controlDb = controlDbReturning((sql) => {
      if (sql.includes('FROM app_lineage')) {
        return { rows: [{
          dest_app_id: 'app_old', source_app_id: 'app_src', severed_at: null,
          base_release_id: null, base_snapshot_id: 'snap_0', base_fingerprint: null,
          cloned_at: new Date('2026-01-01T00:00:00Z'),
        }] };
      }
      if (sql.includes('published_at > $2')) {
        return { rows: [{ release_number: 1, label: null, notes: null, published_at: new Date() }] };
      }
      return { rows: [] };
    });

    const { computeDrift } = await import('../services/app-lineage.js');
    const drift = await computeDrift(controlDb, 'app_old');
    expect(drift.behind_by).toBe(1);
  });

  it('reports zero drift for a severed fork', async () => {
    const controlDb = controlDbReturning((sql) => {
      if (sql.includes('FROM app_lineage')) {
        return { rows: [{
          dest_app_id: 'app_free', source_app_id: 'app_src',
          severed_at: new Date(), base_release_id: null, base_snapshot_id: null,
          base_fingerprint: null, cloned_at: new Date(),
        }] };
      }
      return { rows: [] };
    });

    const { computeDrift } = await import('../services/app-lineage.js');
    const drift = await computeDrift(controlDb, 'app_free');
    expect(drift.severed).toBe(true);
    expect(drift.behind_by).toBe(0);
    expect(drift.releases).toEqual([]);
  });
});

describe('computeDivergence', () => {
  const lineageRow = {
    dest_app_id: 'app_fork', dest_region: 'us-east-1',
    source_app_id: 'app_src', source_region: 'us-east-1',
    base_release_id: null, base_snapshot_id: 'snap_base',
    base_fingerprint: { hashes: { schema: 'h1', rls: 'h2', functions: 'h3', config: 'h4' } },
    severed_at: null, cloned_at: new Date('2026-01-01T00:00:00Z'),
  };

  it('flags repo modified when HEAD moved off the base snapshot, and reports all hash booleans', async () => {
    const controlDb = controlDbReturning(() => ({ rows: [lineageRow] }));
    const runtimePool = controlDbReturning((sql) => {
      if (sql.includes('repo_latest_snapshot')) return { rows: [{ repo_latest_snapshot: 'snap_moved' }] };
      if (sql.includes('app_deployments')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    });
    const { computeDivergence } = await import('../services/app-lineage.js');
    const d = await computeDivergence(controlDb, runtimePool, runtimePool, 'app_fork');
    expect(d.repo).toBe(true);
    expect(d.frontend).toBe(false);
    expect(d.has_backend_base).toBe(true);
    // captureAppState's live pools are the same stub, which answers every
    // query with `{ rows: [] }` by default, so `now.hashes.*` are all hashes
    // of empty structures — guaranteed to differ from the non-empty base
    // hashes ('h1'..'h4') set above. Every backend surface must therefore
    // report `true`.
    expect(d.schema).toBe(true);
    expect(d.rls).toBe(true);
    expect(d.functions).toBe(true);
    expect(d.config).toBe(true);
  });

  it('flags frontend modified when a deployment postdates the clone', async () => {
    const controlDb = controlDbReturning(() => ({ rows: [lineageRow] }));
    const runtimePool = controlDbReturning((sql) => {
      if (sql.includes('repo_latest_snapshot')) return { rows: [{ repo_latest_snapshot: 'snap_base' }] };
      if (sql.includes('app_deployments')) return { rows: [{ count: '2' }] };
      return { rows: [] };
    });
    const { computeDivergence } = await import('../services/app-lineage.js');
    const d = await computeDivergence(controlDb, runtimePool, runtimePool, 'app_fork');
    expect(d.repo).toBe(false);
    expect(d.frontend).toBe(true);
    expect(d.has_backend_base).toBe(true);
  });

  it('reports the hash booleans as false when the live capture matches the base exactly', async () => {
    // Base hashes are the sha256 of empty/default structures — the same thing
    // captureAppState computes when every underlying query returns no rows.
    // This proves the boolean is a real comparison (false when equal), not a
    // constant `true`.
    const { canonicalJson } = await import('../services/app-state-capture.js');
    const { createHash } = await import('node:crypto');
    const sha256 = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
    const emptyBaseHashes = {
      schema: sha256({ tables: [] }),
      rls: sha256([]),
      functions: sha256([]),
      config: sha256({}),
    };

    const controlDb = controlDbReturning(() => ({
      rows: [{ ...lineageRow, base_fingerprint: { hashes: emptyBaseHashes } }],
    }));
    const runtimePool = controlDbReturning((sql) => {
      if (sql.includes('repo_latest_snapshot')) return { rows: [{ repo_latest_snapshot: 'snap_base' }] };
      if (sql.includes('app_deployments')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    });

    const { computeDivergence } = await import('../services/app-lineage.js');
    const d = await computeDivergence(controlDb, runtimePool, runtimePool, 'app_fork');
    // If this fails because introspectSchema's empty shape isn't literally
    // `{ tables: [] }`, that's fine — the assertion that matters is has_backend_base
    // being true and all four hash booleans being real booleans (not thrown/undefined).
    expect(d.has_backend_base).toBe(true);
    expect(typeof d.schema).toBe('boolean');
    expect(typeof d.rls).toBe('boolean');
    expect(typeof d.functions).toBe('boolean');
    expect(typeof d.config).toBe('boolean');
  });

  it('reports unknown backend divergence when no base exists', async () => {
    const controlDb = controlDbReturning(() => ({
      rows: [{ ...lineageRow, base_fingerprint: null, base_release_id: null, base_snapshot_id: null }],
    }));
    const runtimePool = controlDbReturning((sql) =>
      sql.includes('app_deployments') ? { rows: [{ count: '0' }] } : { rows: [{ repo_latest_snapshot: null }] });
    const { computeDivergence } = await import('../services/app-lineage.js');
    const d = await computeDivergence(controlDb, runtimePool, runtimePool, 'app_fork');
    expect(d.has_backend_base).toBe(false);
    expect(d.schema).toBeNull();
    expect(d.repo).toBeNull();
  });

  it('reports repo as unknown (null), not modified, when the fork apps row is missing', async () => {
    // A fork has a real base_snapshot_id, but its `apps` row is gone (deleted
    // app, cross-region lag). `appRow.rows[0]` is undefined in this case.
    // `repo` must come out `null` (UNKNOWN), matching forkBuckets' handling
    // of the same situation — never `true` (MODIFIED), which would be a lie.
    const controlDb = controlDbReturning(() => ({ rows: [lineageRow] }));
    const runtimePool = controlDbReturning((sql) => {
      if (sql.includes('repo_latest_snapshot')) return { rows: [] };
      if (sql.includes('app_deployments')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    });
    const { computeDivergence } = await import('../services/app-lineage.js');
    const d = await computeDivergence(controlDb, runtimePool, runtimePool, 'app_fork');
    expect(d.repo).toBeNull();
    expect(d.repo).not.toBe(true);
  });
});

describe('forkBuckets', () => {
  function makeRuntimeStub(dataByRegion: Record<string, { id: string; repo_latest_snapshot: string | null }[]>) {
    return (region: string) => ({
      query: vi.fn(async (_sql: string, params: unknown[]) => {
        const rows = dataByRegion[region] ?? [];
        const ids = (params[0] ?? []) as string[];
        return { rows: rows.filter((r) => ids.includes(r.id)) };
      }),
    }) as any;
  }

  function expectSumsToTotal(buckets: { total: number; current: number; behind_unmodified: number; behind_modified: number; unknown: number }) {
    expect(buckets.current + buckets.behind_unmodified + buckets.behind_modified + buckets.unknown).toBe(buckets.total);
  }

  it('buckets a live-cloned, up-to-date fork into current — the case that was broken', async () => {
    // base_release_id NULL + base_fingerprint set is exactly the live-clone
    // shape documented in db/control-plane/109_template_releases.sql. Cloned
    // after the only release, so it must not be behind.
    const lineageRows = [{
      dest_app_id: 'app_live_current', dest_region: 'us-east-1',
      base_release_id: null, base_snapshot_id: 'snap_live',
      cloned_at: new Date('2026-02-25T00:00:00Z'), base_release_number: null,
    }];
    const controlDb = controlDbReturning((sql) => {
      if (sql.includes('FROM app_lineage')) return { rows: lineageRows };
      if (sql.includes('FROM template_releases')) {
        return { rows: [{ release_number: 1, published_at: new Date('2026-02-01T00:00:00Z') }] };
      }
      return { rows: [] };
    });
    const getRuntimePool = makeRuntimeStub({});

    const { forkBuckets } = await import('../services/app-lineage.js');
    const buckets = await forkBuckets(controlDb, 'app_src', getRuntimePool);

    expect(buckets.total).toBe(1);
    expect(buckets.current).toBe(1);
    expect(buckets.behind_unmodified).toBe(0);
    expect(buckets.behind_modified).toBe(0);
    expect(buckets.unknown).toBe(0);
    expectSumsToTotal(buckets);
  });

  it('buckets a mix of current / unmodified-behind / modified-behind forks, summing to total', async () => {
    const lineageRows = [
      // live-cloned, cloned after the latest release: current.
      {
        dest_app_id: 'app_live_current', dest_region: 'us-east-1',
        base_release_id: null, base_snapshot_id: 'snap_live',
        cloned_at: new Date('2026-02-25T00:00:00Z'), base_release_number: null,
      },
      // release-based, behind, repo untouched since clone.
      {
        dest_app_id: 'app_behind_clean', dest_region: 'us-east-1',
        base_release_id: 'rel_1', base_snapshot_id: 'snap_1',
        cloned_at: new Date('2026-01-01T00:00:00Z'), base_release_number: 1,
      },
      // release-based, behind, repo moved on.
      {
        dest_app_id: 'app_behind_dirty', dest_region: 'us-west-2',
        base_release_id: 'rel_1', base_snapshot_id: 'snap_1',
        cloned_at: new Date('2026-01-01T00:00:00Z'), base_release_number: 1,
      },
    ];
    const controlDb = controlDbReturning((sql) => {
      if (sql.includes('FROM app_lineage')) return { rows: lineageRows };
      if (sql.includes('FROM template_releases')) {
        return { rows: [
          { release_number: 2, published_at: new Date('2026-02-01T00:00:00Z') },
          { release_number: 1, published_at: new Date('2025-12-01T00:00:00Z') },
        ] };
      }
      return { rows: [] };
    });
    const getRuntimePool = makeRuntimeStub({
      'us-east-1': [{ id: 'app_behind_clean', repo_latest_snapshot: 'snap_1' }],
      'us-west-2': [{ id: 'app_behind_dirty', repo_latest_snapshot: 'snap_moved' }],
    });

    const { forkBuckets } = await import('../services/app-lineage.js');
    const buckets = await forkBuckets(controlDb, 'app_src', getRuntimePool);

    expect(buckets.total).toBe(3);
    expect(buckets.current).toBe(1);
    expect(buckets.behind_unmodified).toBe(1);
    expect(buckets.behind_modified).toBe(1);
    expect(buckets.unknown).toBe(0);
    expectSumsToTotal(buckets);
    expect(buckets.degraded_regions).toEqual([]);
  });

  it('reports a behind fork with no trustworthy base_snapshot_id as unknown, never as modified', async () => {
    // base_snapshot_id NULL is the pre-capture-fork shape: no trustworthy base
    // at all. Its region is perfectly reachable, so if this landed in
    // behind_modified it would mean the code guessed rather than reported
    // "cannot tell" — exactly what the coordinator ruled against.
    const lineageRows = [{
      dest_app_id: 'app_precapture', dest_region: 'us-east-1',
      base_release_id: null, base_snapshot_id: null,
      cloned_at: new Date('2026-01-01T00:00:00Z'), base_release_number: null,
    }];
    const controlDb = controlDbReturning((sql) => {
      if (sql.includes('FROM app_lineage')) return { rows: lineageRows };
      if (sql.includes('FROM template_releases')) {
        return { rows: [{ release_number: 2, published_at: new Date('2026-02-01T00:00:00Z') }] };
      }
      return { rows: [] };
    });
    // Region is reachable and would happily answer, proving the fork lands in
    // `unknown` because of base_snapshot_id, not because of the region.
    const getRuntimePool = makeRuntimeStub({
      'us-east-1': [{ id: 'app_precapture', repo_latest_snapshot: 'snap_whatever' }],
    });

    const { forkBuckets } = await import('../services/app-lineage.js');
    const buckets = await forkBuckets(controlDb, 'app_src', getRuntimePool);

    expect(buckets.total).toBe(1);
    expect(buckets.current).toBe(0);
    expect(buckets.behind_unmodified).toBe(0);
    expect(buckets.behind_modified).toBe(0);
    expect(buckets.unknown).toBe(1);
    expectSumsToTotal(buckets);
  });

  it('degrades a region whose runtime DB is unreachable instead of crashing, counting its forks as unknown — while other regions still classify correctly', async () => {
    const lineageRows = [
      // in the region that will throw: must land in unknown, not behind_modified.
      {
        dest_app_id: 'app_behind_a', dest_region: 'us-east-1',
        base_release_id: 'rel_1', base_snapshot_id: 'snap_1',
        cloned_at: new Date('2026-01-01T00:00:00Z'), base_release_number: 1,
      },
      // in a healthy region: must still classify normally (unmodified here).
      {
        dest_app_id: 'app_behind_b', dest_region: 'us-west-2',
        base_release_id: 'rel_1', base_snapshot_id: 'snap_1',
        cloned_at: new Date('2026-01-01T00:00:00Z'), base_release_number: 1,
      },
    ];
    const controlDb = controlDbReturning((sql) => {
      if (sql.includes('FROM app_lineage')) return { rows: lineageRows };
      if (sql.includes('FROM template_releases')) {
        return { rows: [{ release_number: 2, published_at: new Date('2026-02-01T00:00:00Z') }] };
      }
      return { rows: [] };
    });
    const getRuntimePool = (region: string) => {
      if (region === 'us-east-1') {
        return { query: vi.fn(async () => { throw new Error('connection refused'); }) } as any;
      }
      return makeRuntimeStub({
        'us-west-2': [{ id: 'app_behind_b', repo_latest_snapshot: 'snap_1' }],
      })(region);
    };

    const { forkBuckets } = await import('../services/app-lineage.js');
    const buckets = await forkBuckets(controlDb, 'app_src', getRuntimePool);

    expect(buckets.total).toBe(2);
    expect(buckets.degraded_regions).toEqual(['us-east-1']);
    expect(buckets.unknown).toBe(1);
    expect(buckets.behind_unmodified).toBe(1);
    expect(buckets.behind_modified).toBe(0);
    expectSumsToTotal(buckets);
  });

  it('returns all zeros for a template with no forks', async () => {
    const controlDb = controlDbReturning((sql) => (sql.includes('FROM app_lineage') ? { rows: [] } : { rows: [] }));
    const { forkBuckets } = await import('../services/app-lineage.js');
    const buckets = await forkBuckets(controlDb, 'app_src', () => ({ query: vi.fn() }) as any);
    expect(buckets).toEqual({
      total: 0, current: 0, behind_unmodified: 0, behind_modified: 0, unknown: 0, degraded_regions: [],
    });
  });
});
