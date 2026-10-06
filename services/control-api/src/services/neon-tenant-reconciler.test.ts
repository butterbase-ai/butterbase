import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  reconcileTenantProjects,
  parseTenantProjectName,
  protectedProjectIds,
  PartialInventoryError,
} from './neon-tenant-reconciler.js';

const HOUR = 3600 * 1000;
const NOW = '2026-08-24T12:00:00.000Z';
const nowMs = Date.parse(NOW);
const ago = (ms: number) => new Date(nowMs - ms).toISOString();

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const OPTS = { graceHours: 24, maxDeletesPerRun: 10, dryRun: false, now: NOW };

/** A runtime-db config stub whose pools answer the two queries this file makes. */
function runtimeStub(opts: {
  referencedByRegion: Record<string, string[]>;
  inflightAppIds?: string[];
  failRegions?: string[];
}) {
  const pools = new Map<string, { query: ReturnType<typeof vi.fn> }>();
  for (const region of Object.keys(opts.referencedByRegion)) {
    pools.set(region, {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (opts.failRegions?.includes(region)) throw new Error('connection refused');
        if (sql.includes('app_db_connections')) {
          return { rows: opts.referencedByRegion[region].map((id) => ({ neon_project_id: id })) };
        }
        if (sql.includes('neon_tasks')) {
          const appId = (params?.[0] as string) ?? '';
          const hit = opts.inflightAppIds?.includes(appId) ? '1' : '0';
          return { rows: [{ c: hit }] };
        }
        return { rows: [] };
      }),
    });
  }
  return pools;
}

// getRuntimeDbPool is module-level; mock it to hand back our stubs.
const { poolRegistry } = vi.hoisted(() => ({ poolRegistry: { current: new Map<string, unknown>() } }));
vi.mock('./runtime-db.js', () => ({
  getRuntimeDbPool: (_cfg: unknown, region: string) => {
    const p = poolRegistry.current.get(region);
    if (!p) throw new Error(`no stub pool for region ${region}`);
    return p;
  },
}));

function run(args: {
  projects: { id: string; name: string; created_at: string }[];
  referencedByRegion: Record<string, string[]>;
  inflightAppIds?: string[];
  failRegions?: string[];
  opts?: Partial<typeof OPTS>;
  deleteProject?: ReturnType<typeof vi.fn>;
}) {
  poolRegistry.current = runtimeStub({
    referencedByRegion: args.referencedByRegion,
    inflightAppIds: args.inflightAppIds,
    failRegions: args.failRegions,
  }) as Map<string, unknown>;

  return reconcileTenantProjects(
    {} as never,
    {} as never,
    logger,
    { ...OPTS, ...args.opts },
    {
      listTenantProjects: async () => args.projects,
      deleteProject: args.deleteProject ?? vi.fn(async () => {}),
      regions: Object.keys(args.referencedByRegion),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NEON_DATA_PROJECT_ID;
  delete process.env.NEON_DATA_PROJECT_ID_US_EAST_1;
  delete process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1;
});
afterEach(() => {
  delete process.env.NEON_DATA_PROJECT_ID;
  delete process.env.NEON_DATA_PROJECT_ID_US_EAST_1;
  delete process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1;
});

describe('parseTenantProjectName', () => {
  it('parses the exact shape projectNameForApp produces', () => {
    expect(parseTenantProjectName('bb-app_k3f9x2m1qp0z-us-east-1')).toEqual({
      appId: 'app_k3f9x2m1qp0z',
      region: 'us-east-1',
    });
  });

  it('refuses anything that is not that shape', () => {
    for (const bad of [
      'bb-app_abc',                      // no region
      'bb-notanapp-us-east-1',           // bad app id
      'data-us-west-2',                  // a shared project
      'bb-app_abc-us-east-1-extra',      // trailing junk
      'runtime-us-east-1',
    ]) {
      expect(parseTenantProjectName(bad), bad).toBeNull();
    }
  });
});

describe('reconcileTenantProjects — identity', () => {
  it('deletes a tenant project that no app row references', async () => {
    const deleteProject = vi.fn(async () => {});
    const r = await run({
      projects: [{ id: 'proj-orphan', name: 'bb-app_aaaaaaaaaaaa-us-east-1', created_at: ago(48 * HOUR) }],
      referencedByRegion: { 'us-east-1': ['proj-live'] },
      deleteProject,
    });

    expect(r.orphanCount).toBe(1);
    expect(r.deleted).toEqual(['bb-app_aaaaaaaaaaaa-us-east-1']);
    expect(deleteProject).toHaveBeenCalledWith('proj-orphan');
  });

  it('NEVER deletes a project referenced by an app row, however old', async () => {
    const deleteProject = vi.fn(async () => {});
    const r = await run({
      projects: [{ id: 'proj-live', name: 'bb-app_aaaaaaaaaaaa-us-east-1', created_at: ago(9000 * HOUR) }],
      referencedByRegion: { 'us-east-1': ['proj-live'] },
      deleteProject,
    });

    expect(r.orphanCount).toBe(0);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('counts a project as live when ANY region references it, not just its own', async () => {
    // A region move leaves the source project referenced from the other side.
    // Scoping the reference set per-region would delete the retained source.
    const deleteProject = vi.fn(async () => {});
    await run({
      projects: [{ id: 'proj-moved', name: 'bb-app_aaaaaaaaaaaa-us-east-1', created_at: ago(48 * HOUR) }],
      referencedByRegion: { 'us-east-1': [], 'us-west-2': ['proj-moved'] },
      deleteProject,
    });

    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('ignores projects that are not named bb-app_*', async () => {
    const deleteProject = vi.fn(async () => {});
    const r = await run({
      projects: [
        { id: 'p1', name: 'data-us-west-2', created_at: ago(9000 * HOUR) },
        { id: 'p2', name: 'runtime-us-east-1', created_at: ago(9000 * HOUR) },
        { id: 'p3', name: 'Butterbase Substrate', created_at: ago(9000 * HOUR) },
      ],
      referencedByRegion: { 'us-east-1': [] },
      deleteProject,
    });

    expect(r.orphanCount).toBe(0);
    expect(deleteProject).not.toHaveBeenCalled();
  });
});

describe('reconcileTenantProjects — safeties', () => {
  it('respects the grace period for a freshly created project', async () => {
    // The exact race the reconciler exists to avoid causing: a project created
    // seconds ago whose app row has not been written yet.
    const deleteProject = vi.fn(async () => {});
    const r = await run({
      projects: [{ id: 'proj-new', name: 'bb-app_aaaaaaaaaaaa-us-east-1', created_at: ago(1 * HOUR) }],
      referencedByRegion: { 'us-east-1': [] },
      deleteProject,
    });

    expect(r.skippedYoung).toBe(1);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('skips a project whose app still has an in-flight neon task', async () => {
    const deleteProject = vi.fn(async () => {});
    const r = await run({
      projects: [{ id: 'proj-busy', name: 'bb-app_bbbbbbbbbbbb-us-east-1', created_at: ago(48 * HOUR) }],
      referencedByRegion: { 'us-east-1': [] },
      inflightAppIds: ['app_bbbbbbbbbbbb'],
      deleteProject,
    });

    expect(r.skippedInflight).toBe(1);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('treats an unparseable bb-app_ name as ambiguous and never deletes it', async () => {
    const deleteProject = vi.fn(async () => {});
    const r = await run({
      projects: [{ id: 'proj-weird', name: 'bb-app_ZZZ!!-nonsense', created_at: ago(9000 * HOUR) }],
      referencedByRegion: { 'us-east-1': [] },
      deleteProject,
    });

    expect(r.skippedAmbiguous).toBe(1);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('caps deletes per run, oldest first', async () => {
    const deleteProject = vi.fn(async () => {});
    const r = await run({
      projects: [
        { id: 'p-young', name: 'bb-app_aaaaaaaaaaaa-us-east-1', created_at: ago(30 * HOUR) },
        { id: 'p-old', name: 'bb-app_bbbbbbbbbbbb-us-east-1', created_at: ago(900 * HOUR) },
        { id: 'p-mid', name: 'bb-app_cccccccccccc-us-east-1', created_at: ago(200 * HOUR) },
      ],
      referencedByRegion: { 'us-east-1': [] },
      opts: { maxDeletesPerRun: 2 },
      deleteProject,
    });

    expect(r.eligibleCount).toBe(3);
    expect(deleteProject).toHaveBeenCalledTimes(2);
    expect(deleteProject.mock.calls.map((c) => c[0])).toEqual(['p-old', 'p-mid']);
  });

  it('dry-run reports without deleting anything', async () => {
    const deleteProject = vi.fn(async () => {});
    const r = await run({
      projects: [{ id: 'proj-orphan', name: 'bb-app_aaaaaaaaaaaa-us-east-1', created_at: ago(48 * HOUR) }],
      referencedByRegion: { 'us-east-1': [] },
      opts: { dryRun: true },
      deleteProject,
    });

    expect(r.wouldDelete).toEqual(['bb-app_aaaaaaaaaaaa-us-east-1']);
    expect(r.deleted).toEqual([]);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('never deletes a protected infrastructure project id', async () => {
    process.env.NEON_DATA_PROJECT_ID_US_EAST_1 = 'proj-shared';
    const deleteProject = vi.fn(async () => {});
    const r = await run({
      // Contrived name — the denylist must hold even if naming ever collides.
      projects: [{ id: 'proj-shared', name: 'bb-app_aaaaaaaaaaaa-us-east-1', created_at: ago(9000 * HOUR) }],
      referencedByRegion: { 'us-east-1': [] },
      deleteProject,
    });

    expect(r.orphanCount).toBe(0);
    expect(deleteProject).not.toHaveBeenCalled();
  });
});

describe('reconcileTenantProjects — abort on partial inventory', () => {
  it('aborts the whole cycle when a region runtime DB is unreadable', async () => {
    // THE load-bearing test. Orphan-ness is proved by absence; a region we
    // cannot read makes every app in it look orphaned. Deleting on a partial
    // inventory would destroy live customer databases.
    const deleteProject = vi.fn(async () => {});
    await expect(run({
      projects: [{ id: 'proj-orphan', name: 'bb-app_aaaaaaaaaaaa-us-east-1', created_at: ago(48 * HOUR) }],
      referencedByRegion: { 'us-east-1': [], 'us-west-2': [] },
      failRegions: ['us-west-2'],
      deleteProject,
    })).rejects.toThrow(PartialInventoryError);

    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('aborts when the project listing itself fails', async () => {
    poolRegistry.current = runtimeStub({ referencedByRegion: { 'us-east-1': [] } }) as Map<string, unknown>;
    const deleteProject = vi.fn(async () => {});

    await expect(reconcileTenantProjects(
      {} as never, {} as never, logger, OPTS,
      {
        listTenantProjects: async () => { throw new PartialInventoryError('listing blew up'); },
        deleteProject,
        regions: ['us-east-1'],
      },
    )).rejects.toThrow(PartialInventoryError);

    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('aborts when no regions are configured rather than treating everything as orphaned', async () => {
    const deleteProject = vi.fn(async () => {});
    await expect(reconcileTenantProjects(
      {} as never, {} as never, logger, OPTS,
      {
        listTenantProjects: async () => [
          { id: 'proj-orphan', name: 'bb-app_aaaaaaaaaaaa-us-east-1', created_at: ago(48 * HOUR) },
        ],
        deleteProject,
        regions: [],
      },
    )).rejects.toThrow(PartialInventoryError);

    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('records a delete failure without aborting the remaining deletes', async () => {
    const deleteProject = vi.fn(async (id: string) => {
      if (id === 'p-bad') throw new Error('423 conflicting operation');
    });
    const r = await run({
      projects: [
        { id: 'p-bad', name: 'bb-app_bbbbbbbbbbbb-us-east-1', created_at: ago(900 * HOUR) },
        { id: 'p-ok', name: 'bb-app_cccccccccccc-us-east-1', created_at: ago(200 * HOUR) },
      ],
      referencedByRegion: { 'us-east-1': [] },
      deleteProject,
    });

    expect(r.deleteErrors).toHaveLength(1);
    expect(r.deleted).toEqual(['bb-app_cccccccccccc-us-east-1']);
  });
});

describe('protectedProjectIds', () => {
  it('collects shared data and runtime project ids per region', () => {
    process.env.NEON_DATA_PROJECT_ID_US_EAST_1 = 'data-east';
    process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 = 'runtime-east';
    const ids = protectedProjectIds(['us-east-1']);
    expect(ids.has('data-east')).toBe(true);
    expect(ids.has('runtime-east')).toBe(true);
  });
});
