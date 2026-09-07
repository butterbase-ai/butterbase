import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { mockCreateCloneJob } = vi.hoisted(() => ({ mockCreateCloneJob: vi.fn() }));

vi.mock('../services/clone-jobs.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/clone-jobs.js')>();
  return { ...orig, createCloneJob: mockCreateCloneJob };
});

vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(async () => ({
    query: vi.fn(async () => ({
      rows: [{ id: 'app_src', visibility: 'public', region: 'iad', repo_latest_snapshot: 'snap_1' }],
    })),
  })),
}));

vi.mock('../services/project-quota.js', () => ({
  checkProjectQuota: vi.fn(async () => ({ ok: true })),
}));

const logger = { warn: vi.fn() };

function controlDbWith(rowsByQuery: (sql: string) => unknown[]) {
  return { query: vi.fn(async (sql: string) => ({ rows: rowsByQuery(sql), rowCount: rowsByQuery(sql).length })) } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateCloneJob.mockResolvedValue({ id: 'cj_1', dest_app_id: null });
});

describe('startClone', () => {
  it('rejects a name already present in org_app_index', async () => {
    const { startClone } = await import('../services/start-clone.js');
    const controlDb = controlDbWith((sql) =>
      sql.includes('org_app_index') ? [{ app_id: 'app_other' }] : [{ c: 0 }],
    );
    const res = await startClone({
      controlDb, sourceAppId: 'app_src', userId: 'usr_1', destOrgId: 'org_1',
      name: 'taken-name', logger,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('NAME_TAKEN');
  });

  it('rejects when the user already has 3 in-flight clones', async () => {
    const { startClone } = await import('../services/start-clone.js');
    const controlDb = controlDbWith((sql) =>
      sql.includes('org_app_index') ? [] : [{ c: 3 }],
    );
    const res = await startClone({
      controlDb, sourceAppId: 'app_src', userId: 'usr_1', destOrgId: 'org_1', logger,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('INFLIGHT_LIMIT');
  });

  it('rejects non-string env var values', async () => {
    const { startClone } = await import('../services/start-clone.js');
    const controlDb = controlDbWith((sql) => (sql.includes('org_app_index') ? [] : [{ c: 0 }]));
    const res = await startClone({
      controlDb, sourceAppId: 'app_src', userId: 'usr_1', destOrgId: 'org_1',
      envVarValues: { fn: { KEY: 123 as unknown as string } }, logger,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('INVALID_ENV_SHAPE');
  });

  it('creates a job and returns ok on the happy path', async () => {
    const { startClone } = await import('../services/start-clone.js');
    const controlDb = controlDbWith((sql) => (sql.includes('org_app_index') ? [] : [{ c: 0 }]));
    const res = await startClone({
      controlDb, sourceAppId: 'app_src', userId: 'usr_1', destOrgId: 'org_1',
      name: 'fresh-name', logger,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.jobId).toBe('cj_1');
      expect(res.sourceRegion).toBe('iad');
    }
    expect(mockCreateCloneJob).toHaveBeenCalledOnce();
  });
});
