import { describe, it, expect, vi } from 'vitest';

function controlDbReturning(handler: (sql: string, params: unknown[]) => { rows: unknown[] }) {
  return { query: vi.fn(async (sql: string, params: unknown[] = []) => handler(sql, params)) } as any;
}

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
      if (sql.includes('release_number >')) {
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

  it('falls back to cloned_at when there is no base release', async () => {
    const controlDb = controlDbReturning((sql) => {
      if (sql.includes('FROM app_lineage')) {
        return { rows: [{
          dest_app_id: 'app_old', source_app_id: 'app_src', severed_at: null,
          base_release_id: null, base_snapshot_id: 'snap_0', base_fingerprint: null,
          cloned_at: new Date('2026-01-01T00:00:00Z'),
        }] };
      }
      if (sql.includes('published_at >')) {
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

  it('flags repo modified when HEAD moved off the base snapshot', async () => {
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
});
