import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEnvironmentLink: vi.fn(),
  getLinkByStagingApp: vi.fn(),
  startClone: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
  allocateStagingSubdomain: vi.fn(),
  getProvisionAllowedRegions: vi.fn(),
  setCloneJobStatus: vi.fn(),
}));

vi.mock('./app-environments.js', () => ({
  getEnvironmentLink: mocks.getEnvironmentLink,
  getLinkByStagingApp: mocks.getLinkByStagingApp,
}));
vi.mock('./start-clone.js', () => ({ startClone: mocks.startClone }));
vi.mock('./region-resolver.js', () => ({ getRuntimeDbForApp: mocks.getRuntimeDbForApp }));
vi.mock('./staging-naming.js', async () => {
  const actual = await vi.importActual<typeof import('./staging-naming.js')>('./staging-naming.js');
  return {
    deriveStagingName: actual.deriveStagingName,
    allocateStagingSubdomain: mocks.allocateStagingSubdomain,
  };
});
vi.mock('./provision-region.js', () => ({
  getProvisionAllowedRegions: mocks.getProvisionAllowedRegions,
}));
// Partial mock: start-staging.ts also reads TERMINAL_CLONE_STATUSES (for its
// CREATE_IN_FLIGHT precheck). A bare object mock omitted it, so every test in
// this file threw "No TERMINAL_CLONE_STATUSES export is defined" — a stale
// mock left behind when that import was added. Keep the real constant and mock
// only the function.
vi.mock('./clone-jobs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./clone-jobs.js')>();
  return { ...actual, setCloneJobStatus: mocks.setCloneJobStatus };
});

import { startStaging, sendStartStagingFailure } from './start-staging.js';
import { quotaErrors } from '../utils/quota-errors.js';

// Minimal FastifyReply stand-in — same shape used by start-clone.test.ts's
// fakeReply for the same purpose (asserting a status/body mapping without
// spinning up a real Fastify instance).
function fakeReply() {
  const reply: any = {
    statusCode: 0,
    body: undefined,
    code(c: number) { reply.statusCode = c; return reply; },
    send(b: unknown) { reply.body = b; return reply; },
  };
  return reply;
}

const controlDbQuery = vi.fn().mockResolvedValue({ rows: [] });

const baseArgs = {
  controlDb: { query: controlDbQuery } as never,
  prodAppId: 'app_prod',
  userId: '00000000-0000-0000-0000-0000000000e1',
  orgId: 'org_1',
  logger: { warn: () => {} },
};

// getRuntimeDbForApp resolves to a plain pg.Pool (see region-resolver.ts) —
// not a { pool, region } wrapper. Region for a given app comes from the
// `apps` row itself, exactly as start-clone.ts does it.
function fakeRuntimePool(rows: Array<{ name: string; region: string; subdomain: string | null; organization_id?: string | null }>) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  controlDbQuery.mockClear();
  controlDbQuery.mockResolvedValue({ rows: [] });
  mocks.getEnvironmentLink.mockResolvedValue(null);
  mocks.getLinkByStagingApp.mockResolvedValue(null);
  mocks.getRuntimeDbForApp.mockResolvedValue(
    fakeRuntimePool([{ name: 'my-crm', region: 'us-east-1', subdomain: 'my-crm', organization_id: 'org_1' }]),
  );
  mocks.allocateStagingSubdomain.mockResolvedValue('my-crm-staging');
  // Empty list = no restriction configured (see provision-region.ts), matching
  // the default env-var-unset behaviour.
  mocks.getProvisionAllowedRegions.mockReturnValue([]);
  mocks.setCloneJobStatus.mockResolvedValue(undefined);
  mocks.startClone.mockResolvedValue({
    ok: true, jobId: 'job_1', destAppId: null, sourceAppId: 'app_prod',
    sourceRegion: 'us-east-1', destRegion: 'us-east-1',
  });
});

describe('startStaging', () => {
  it('starts a clone pinned to the production app region', async () => {
    const res = await startStaging(baseArgs);
    expect(res.ok).toBe(true);
    expect(mocks.startClone).toHaveBeenCalledWith(
      expect.objectContaining({ destRegion: 'us-east-1', name: 'my-crm-staging' }),
    );
    // Sourced from the clone result, not the pre-clone local — see below.
    expect(res).toMatchObject({ region: 'us-east-1' });
  });

  // Defect 1 (task-20 report): startClone's visibility='public' and
  // repo-snapshot admission rules only make sense for the public-template
  // -clone flow. This test only proves the WIRING (that startStaging opts
  // in); the real admission behaviour is exercised without mocking
  // startClone away in start-clone.test.ts's
  // "skipVisibilityAndSnapshotChecks (staging opt-in)" block, since a full
  // mock here — as this file used before — is exactly what hid the defect.
  it('opts startClone out of the public-visibility and repo-snapshot admission checks', async () => {
    await startStaging(baseArgs);
    expect(mocks.startClone).toHaveBeenCalledWith(
      expect.objectContaining({ skipVisibilityAndSnapshotChecks: true }),
    );
  });

  it('refuses when the app already has a staging environment', async () => {
    mocks.getEnvironmentLink.mockResolvedValue({ staging_app_id: 'app_staging' });
    const res = await startStaging(baseArgs);
    expect(res).toMatchObject({ ok: false, code: 'ALREADY_EXISTS', stagingAppId: 'app_staging' });
    expect(mocks.startClone).not.toHaveBeenCalled();
  });

  it('refuses to create a staging environment of a staging app', async () => {
    mocks.getLinkByStagingApp.mockResolvedValue({ prod_app_id: 'app_other' });
    const res = await startStaging(baseArgs);
    expect(res).toMatchObject({ ok: false, code: 'IS_STAGING' });
    expect(mocks.startClone).not.toHaveBeenCalled();
  });

  it('surfaces a clone refusal rather than swallowing it', async () => {
    mocks.startClone.mockResolvedValue({ ok: false, code: 'QUOTA_EXCEEDED', current: 5, limit: 5 });
    const res = await startStaging(baseArgs);
    expect(res).toMatchObject({ ok: false, code: 'CLONE_REFUSED' });
  });

  it('refuses when the production app does not exist', async () => {
    mocks.getRuntimeDbForApp.mockResolvedValue(fakeRuntimePool([]));
    const res = await startStaging(baseArgs);
    expect(res).toMatchObject({ ok: false, code: 'PROD_NOT_FOUND' });
  });

  // --- Mandatory deviation from the brief: allocateStagingSubdomain must
  // actually be called, not deriveStagingName alone, because apps.subdomain
  // carries a global unique index and an unrelated app may already hold
  // "<name>-staging".

  it('calls allocateStagingSubdomain with the prod app subdomain and returns it as stagingSubdomain', async () => {
    mocks.allocateStagingSubdomain.mockResolvedValue('my-crm-staging-3');
    const res = await startStaging(baseArgs);
    expect(mocks.allocateStagingSubdomain).toHaveBeenCalledWith(
      expect.anything(), 'my-crm',
    );
    expect(res).toMatchObject({ ok: true, stagingSubdomain: 'my-crm-staging-3' });
  });

  it('returns NO_SUBDOMAIN when allocateStagingSubdomain exhausts its attempts, without calling startClone', async () => {
    mocks.allocateStagingSubdomain.mockRejectedValue(
      new Error('No free subdomain for staging of "my-crm" after 10 attempts.'),
    );
    const res = await startStaging(baseArgs);
    expect(res).toMatchObject({ ok: false, code: 'NO_SUBDOMAIN' });
    expect(mocks.startClone).not.toHaveBeenCalled();
  });

  it('falls back to deriving the subdomain from the app name when apps.subdomain is NULL', async () => {
    mocks.getRuntimeDbForApp.mockResolvedValue(
      fakeRuntimePool([{ name: 'my-crm', region: 'us-east-1', subdomain: null }]),
    );
    const res = await startStaging(baseArgs);
    expect(mocks.allocateStagingSubdomain).toHaveBeenCalledWith(expect.anything(), 'my-crm');
    expect(res.ok).toBe(true);
  });

  // --- Fix round 1: the production app's region must be honoured exactly,
  // never silently redirected by startClone's closed-region logic —
  // app_environments FKs are local to one regional runtime DB.

  it('refuses up front when the production app region is closed to new apps, without calling startClone', async () => {
    mocks.getProvisionAllowedRegions.mockReturnValue(['us-west-2']);
    const res = await startStaging(baseArgs);
    expect(res).toMatchObject({ ok: false, code: 'REGION_CLOSED', region: 'us-east-1' });
    expect(mocks.startClone).not.toHaveBeenCalled();
    expect(mocks.setCloneJobStatus).not.toHaveBeenCalled();
  });

  it('marks the job failed and refuses when startClone redirects to a different region despite the pre-check passing', async () => {
    mocks.startClone.mockResolvedValue({
      ok: true, jobId: 'job_redirected', destAppId: null, sourceAppId: 'app_prod',
      sourceRegion: 'us-east-1', destRegion: 'us-west-2', redirectedFromRegion: 'us-east-1',
    });
    const res = await startStaging(baseArgs);
    expect(mocks.setCloneJobStatus).toHaveBeenCalledWith(
      expect.anything(), 'job_redirected',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(res).toMatchObject({ ok: false, code: 'REGION_CLOSED' });
    // The success path (the mode = 'staging_create' UPDATE) must not run.
    // Narrowed to the UPDATE: the CREATE_IN_FLIGHT precheck SELECT legitimately
    // mentions mode = 'staging_create' and runs before the refusal.
    const successWrites = controlDbQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE template_clone_jobs'),
    );
    expect(successWrites).toHaveLength(0);
  });

  // --- REGRESSION for defect 1 (final whole-branch review).
  //
  // startStaging allocated a staging subdomain, returned it to the caller as
  // `staging_subdomain`, and then THREW IT AWAY: nothing carried it to the
  // clone worker, which independently derived its own from the destination
  // name with a random numeric suffix. The API therefore told the user a
  // subdomain the app did not have. The response is sent long before the
  // worker runs, so the only way that response can be true is if the value it
  // names is the value that is actually persisted for the worker to apply.
  //
  // Asserting the mode UPDATE alone would NOT have caught the defect — the
  // pre-fix code issued exactly that UPDATE. What has to be pinned is that the
  // allocated value reaches the job row, and that it is the SAME value the
  // response reports.

  it('persists the allocated subdomain onto the job so the worker applies it', async () => {
    mocks.allocateStagingSubdomain.mockResolvedValue('my-crm-staging-4');
    const res = await startStaging(baseArgs);
    expect(res).toMatchObject({ ok: true, stagingSubdomain: 'my-crm-staging-4' });

    const write = controlDbQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('dest_subdomain'),
    );
    expect(write, 'the allocated subdomain must be written to the clone job').toBeDefined();
    expect(write![0]).toContain("mode = 'staging_create'");
    expect(write![1]).toEqual(['job_1', 'my-crm-staging-4']);
  });

  it('writes mode and dest_subdomain in one statement, so a staging_create can never exist without its pinned subdomain', async () => {
    await startStaging(baseArgs);
    // Filtered to UPDATEs: the CREATE_IN_FLIGHT precheck SELECT also mentions
    // mode = 'staging_create'.
    const modeWrites = controlDbQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string'
        && sql.includes('UPDATE template_clone_jobs')
        && sql.includes("mode = 'staging_create'"),
    );
    expect(modeWrites).toHaveLength(1);
    expect(modeWrites[0][0]).toContain('dest_subdomain');
  });

  // --- Destination org must come from the production app, not the caller.
  //
  // The caller's orgId is whoever happened to click the button; the app's
  // organization_id is whoever actually owns production. Billing, quota
  // (Task 5) and the plan gate (Task 3) all need the latter, not the former.

  it('uses the production app organization_id as destOrgId, not the caller-supplied orgId', async () => {
    mocks.getRuntimeDbForApp.mockResolvedValue(
      fakeRuntimePool([{ name: 'my-crm', region: 'us-east-1', subdomain: 'my-crm', organization_id: 'org_team' }]),
    );
    const res = await startStaging({ ...baseArgs, orgId: 'org_personal' });
    expect(res.ok).toBe(true);
    expect(mocks.startClone).toHaveBeenCalledWith(
      expect.objectContaining({ destOrgId: 'org_team' }),
    );
  });

  it('falls back to the caller-supplied orgId when the production app has no organization_id (legacy pre-backfill)', async () => {
    mocks.getRuntimeDbForApp.mockResolvedValue(
      fakeRuntimePool([{ name: 'my-crm', region: 'us-east-1', subdomain: 'my-crm', organization_id: null }]),
    );
    const res = await startStaging({ ...baseArgs, orgId: 'org_personal' });
    expect(res.ok).toBe(true);
    expect(mocks.startClone).toHaveBeenCalledWith(
      expect.objectContaining({ destOrgId: 'org_personal' }),
    );
  });

  it('allocates against BOTH planes, not the regional runtime plane alone', async () => {
    await startStaging(baseArgs);
    // Subdomains are globally unique via the control-plane org_app_index; an
    // allocator handed only the regional pool cannot see a name another region
    // owns. Pinning the shape of the argument is what keeps the request-time
    // allocator and the clone worker checking the same namespace.
    expect(mocks.allocateStagingSubdomain).toHaveBeenCalledWith(
      expect.objectContaining({
        controlDb: baseArgs.controlDb,
        runtimeDb: expect.anything(),
      }),
      'my-crm',
    );
  });

  // --- Task 5: the quota refusal startClone already enforces (Task 4 pins it
  // to the production app's org, not the caller's) must reach the caller with
  // its numbers and an upgrade path intact, not as a bare 400 enum name.

  it('drives QUOTA_EXCEEDED through the existing startClone mock as a CLONE_REFUSED with the numbers intact', async () => {
    mocks.startClone.mockResolvedValue({ ok: false, code: 'QUOTA_EXCEEDED', current: 3, limit: 3 });
    const res = await startStaging(baseArgs);
    expect(res).toMatchObject({
      ok: false,
      code: 'CLONE_REFUSED',
      inner: { code: 'QUOTA_EXCEEDED', current: 3, limit: 3 },
    });
  });

  it('checks the quota against the production app org, not the caller org (Task 4 interaction)', async () => {
    mocks.getRuntimeDbForApp.mockResolvedValue(
      fakeRuntimePool([{ name: 'my-crm', region: 'us-east-1', subdomain: 'my-crm', organization_id: 'org_team' }]),
    );
    mocks.startClone.mockResolvedValue({ ok: false, code: 'QUOTA_EXCEEDED', current: 3, limit: 3 });
    await startStaging({ ...baseArgs, orgId: 'org_personal' });
    expect(mocks.startClone).toHaveBeenCalledWith(
      expect.objectContaining({ destOrgId: 'org_team' }),
    );
  });
});

describe('sendStartStagingFailure', () => {
  it('renders a QUOTA_EXCEEDED CLONE_REFUSED as 403 with current, limit and an upgrade URL', () => {
    const reply = fakeReply();
    sendStartStagingFailure(reply, {
      ok: false,
      code: 'CLONE_REFUSED',
      inner: { code: 'QUOTA_EXCEEDED', current: 3, limit: 3 },
    });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toMatchObject({
      error: 'project_limit_reached',
      current: 3,
      limit: 3,
      upgradeUrl: expect.any(String),
    });
    expect(reply.body.message).toEqual(expect.any(String));
  });

  it('states that a staging environment counts as its own project', () => {
    const reply = fakeReply();
    sendStartStagingFailure(reply, {
      ok: false,
      code: 'CLONE_REFUSED',
      inner: { code: 'QUOTA_EXCEEDED', current: 3, limit: 3 },
    });
    expect(reply.body).toEqual(quotaErrors.stagingProjectLimitReached(3, 3));
    expect(reply.body.message.toLowerCase()).toContain('staging');
    expect(reply.body.message).not.toEqual(quotaErrors.projectLimitReached(3, 3).message);
    // checkProjectQuota refuses when current >= limit, so the org is ALREADY at
    // the cap — staging would be one MORE than `current`. The message must not
    // tell someone already using 3 of 3 that creating it "would use 3 of 3".
    expect(reply.body.message).toMatch(/already using 3 of 3/);
    expect(reply.body.message).not.toMatch(/would use 3 of 3/);
  });

  it('leaves other CLONE_REFUSED inner codes at their existing 400/generic-error shape', () => {
    const reply = fakeReply();
    sendStartStagingFailure(reply, {
      ok: false,
      code: 'CLONE_REFUSED',
      inner: { code: 'NAME_TAKEN', name: 'my-crm-staging' },
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.body.error.message).toBe('Cannot create a staging environment: NAME_TAKEN.');
  });
});
