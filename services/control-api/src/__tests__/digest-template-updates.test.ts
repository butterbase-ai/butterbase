import { describe, it, expect, vi } from 'vitest';

// The unmodified-repo check (Step 4 of the task brief) is a genuine
// runtime-tier lookup: apps.repo_latest_snapshot lives per-region and cannot
// be joined from the control-plane query above it. Real infra (redis,
// org_app_index) sits in front of that lookup, so it has to be mocked here
// rather than left to hit whatever happens to be running locally — otherwise
// this test's outcome would depend on unrelated infrastructure state instead
// of the collector's own logic.
const runtimeQuery = vi.fn();
vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(async () => ({ query: runtimeQuery })),
}));

describe('collectTemplateUpdates', () => {
  it('excludes forks that have modified their repo', async () => {
    runtimeQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('repo_latest_snapshot')) {
        return { rows: [{ repo_latest_snapshot: 'snap_base' }] };
      }
      throw new Error(`unexpected runtime query: ${sql}`);
    });

    const controlPool = {
      query: vi.fn(async (sql: string) => {
        expect(sql).toContain('base_snapshot_id');
        if (sql.includes('FROM app_lineage WHERE dest_app_id')) {
          return { rows: [{ base_snapshot_id: 'snap_base' }] };
        }
        return { rows: [
          { dest_app_id: 'app_pristine', source_app_id: 'app_src', behind_by: 2, latest_label: 'v1.4' },
        ] };
      }),
    } as any;

    const { collectTemplateUpdates } = await import('../services/digest-notifier.js');
    const items = await collectTemplateUpdates(controlPool, 'org_1');
    expect(items).toHaveLength(1);
    expect(items[0].dest_app_id).toBe('app_pristine');
  });

  it('excludes a fork whose runtime repo snapshot no longer matches its base (a modified fork)', async () => {
    runtimeQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('repo_latest_snapshot')) {
        return { rows: [{ repo_latest_snapshot: 'snap_edited' }] };
      }
      throw new Error(`unexpected runtime query: ${sql}`);
    });

    const controlPool = {
      query: vi.fn(async (sql: string) => {
        expect(sql).toContain('base_snapshot_id');
        if (sql.includes('FROM app_lineage WHERE dest_app_id')) {
          return { rows: [{ base_snapshot_id: 'snap_base' }] };
        }
        return { rows: [
          { dest_app_id: 'app_dirty', source_app_id: 'app_src', behind_by: 2, latest_label: 'v1.4' },
        ] };
      }),
    } as any;

    const { collectTemplateUpdates } = await import('../services/digest-notifier.js');
    const items = await collectTemplateUpdates(controlPool, 'org_1');
    expect(items).toEqual([]);
  });

  it('returns an empty list when the org has no forks', async () => {
    const controlPool = { query: vi.fn(async () => ({ rows: [] })) } as any;
    const { collectTemplateUpdates } = await import('../services/digest-notifier.js');
    expect(await collectTemplateUpdates(controlPool, 'org_1')).toEqual([]);
  });
});
