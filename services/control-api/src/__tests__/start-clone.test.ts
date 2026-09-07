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

/**
 * The 404 is deliberately identical in status, code and message whether or not
 * the app exists — it must not leak existence. Only the remediation hint
 * differs, and it differed the same way before startClone was extracted. A
 * caller who mistyped an app id must not be told "only public apps are
 * clonable", which points them at a problem they do not have.
 */
describe('startClone source-not-found remediation', () => {
  function fakeReply() {
    const reply: any = {
      statusCode: 0,
      body: undefined,
      code(c: number) { reply.statusCode = c; return reply; },
      send(b: unknown) { reply.body = b; return reply; },
    };
    return reply;
  }

  const controlDbOk = () => controlDbWith((sql) => (sql.includes('org_app_index') ? [] : [{ c: 0 }]));

  it('reports reason=unknown_app when the app is not in org_app_index', async () => {
    const { startClone } = await import('../services/start-clone.js');
    const { getRuntimeDbForApp } = await import('../services/region-resolver.js');
    const { AppNotFoundError } = await import('../services/app-resolver.js');
    vi.mocked(getRuntimeDbForApp).mockRejectedValueOnce(new AppNotFoundError('app_src'));

    const res = await startClone({
      controlDb: controlDbOk(), sourceAppId: 'app_src', userId: 'usr_1', destOrgId: 'org_1', logger,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('SOURCE_NOT_FOUND');
      if (res.code === 'SOURCE_NOT_FOUND') expect(res.reason).toBe('unknown_app');
    }
  });

  it('reports reason=not_public when the app exists but is private', async () => {
    const { startClone } = await import('../services/start-clone.js');
    const { getRuntimeDbForApp } = await import('../services/region-resolver.js');
    vi.mocked(getRuntimeDbForApp).mockResolvedValueOnce({
      query: vi.fn(async () => ({
        rows: [{ id: 'app_src', visibility: 'private', region: 'iad', repo_latest_snapshot: 'snap_1' }],
      })),
    } as any);

    const res = await startClone({
      controlDb: controlDbOk(), sourceAppId: 'app_src', userId: 'usr_1', destOrgId: 'org_1', logger,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('SOURCE_NOT_FOUND');
      if (res.code === 'SOURCE_NOT_FOUND') expect(res.reason).toBe('not_public');
    }
  });

  it('sends the original, distinct remediation for each reason', async () => {
    const { sendStartCloneFailure } = await import('../services/start-clone.js');

    const unknown = fakeReply();
    sendStartCloneFailure(unknown, { ok: false, code: 'SOURCE_NOT_FOUND', reason: 'unknown_app' });
    const notPublic = fakeReply();
    sendStartCloneFailure(notPublic, { ok: false, code: 'SOURCE_NOT_FOUND', reason: 'not_public' });

    // Indistinguishable except for the hint — no existence leak.
    expect(unknown.statusCode).toBe(404);
    expect(notPublic.statusCode).toBe(404);
    expect(unknown.body.error.code).toBe(notPublic.body.error.code);
    expect(unknown.body.error.message).toBe('Source app not found or not public.');
    expect(notPublic.body.error.message).toBe('Source app not found or not public.');

    // The two remediation strings, verbatim from the pre-extraction handler.
    expect(unknown.body.error.remediation)
      .toBe('Verify the app id and that the source app has visibility=public.');
    expect(notPublic.body.error.remediation)
      .toBe('Only public apps are clonable.');
    expect(unknown.body.error.remediation).not.toBe(notPublic.body.error.remediation);
  });
});
