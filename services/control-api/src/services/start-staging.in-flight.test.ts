/**
 * The one guard that stops a second staging app being provisioned for an app
 * that is already building one.
 *
 * `app_environments` is written at the very END of the pipeline, so "no link
 * yet" has never meant "nothing in flight". That window used to be the length
 * of a provision-and-replay; with the production data copy it is that plus the
 * copy, because the job sits in the non-terminal status 'copying_data' until
 * the copy lands. A second POST inside the window provisions a second staging
 * app, only one of which can ever be linked — the other is an orphan the user
 * pays for and cannot see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEnvironmentLink: vi.fn(),
  getLinkByStagingApp: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
  startClone: vi.fn(),
  setCloneJobStatus: vi.fn(),
  deriveStagingName: vi.fn(() => 'app-staging'),
  allocateStagingSubdomain: vi.fn(async () => 'app-staging'),
  getProvisionAllowedRegions: vi.fn(() => [] as string[]),
}));

vi.mock('./app-environments.js', () => ({
  getEnvironmentLink: mocks.getEnvironmentLink,
  getLinkByStagingApp: mocks.getLinkByStagingApp,
}));
vi.mock('./region-resolver.js', () => ({ getRuntimeDbForApp: mocks.getRuntimeDbForApp }));
vi.mock('./start-clone.js', () => ({ startClone: mocks.startClone }));
vi.mock('./clone-jobs.js', () => ({
  setCloneJobStatus: mocks.setCloneJobStatus,
  TERMINAL_CLONE_STATUSES: ['completed', 'failed'],
}));
vi.mock('./staging-naming.js', () => ({
  deriveStagingName: mocks.deriveStagingName,
  allocateStagingSubdomain: mocks.allocateStagingSubdomain,
}));
vi.mock('./provision-region.js', () => ({
  getProvisionAllowedRegions: mocks.getProvisionAllowedRegions,
}));

import { startStaging } from './start-staging.js';

const RUNTIME_ROWS = { rows: [{ name: 'app', region: 'us-east-1', subdomain: 'app' }] };

let inFlightRows: { id: string }[];
let controlDb: { query: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  inFlightRows = [];
  mocks.getLinkByStagingApp.mockResolvedValue(null);
  mocks.getEnvironmentLink.mockResolvedValue(null);
  mocks.getRuntimeDbForApp.mockResolvedValue({ query: vi.fn(async () => RUNTIME_ROWS) });
  mocks.startClone.mockResolvedValue({
    ok: true, jobId: 'cj_new', destRegion: 'us-east-1', redirectedFromRegion: null,
  });
  controlDb = {
    query: vi.fn(async (sql: string) => (
      /FROM template_clone_jobs/.test(sql) ? { rows: inFlightRows } : { rows: [] }
    )),
  };
});

function run() {
  return startStaging({
    controlDb: controlDb as never, prodAppId: 'app_prod', userId: 'u1', orgId: 'org1',
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
  });
}

describe('startStaging in-flight guard', () => {
  it('refuses a second create while the first job is still running', async () => {
    inFlightRows = [{ id: 'cj_first' }];
    const res = await run();
    expect(res).toEqual({ ok: false, code: 'CREATE_IN_FLIGHT', jobId: 'cj_first' });
    expect(mocks.startClone).not.toHaveBeenCalled();
  });

  it('refuses while the first job is parked on the production data copy', async () => {
    // 'copying_data' is non-terminal, so the same NOT (status = ANY(terminal))
    // predicate covers it — this is the window the copy makes long.
    inFlightRows = [{ id: 'cj_copying' }];
    const res = await run();
    expect(res).toEqual({ ok: false, code: 'CREATE_IN_FLIGHT', jobId: 'cj_copying' });
  });

  it('queries only this app\'s staging_create jobs, excluding terminal ones', async () => {
    inFlightRows = [{ id: 'cj_first' }];
    await run();
    const call = controlDb.query.mock.calls.find(
      ([sql]: [string]) => /FROM template_clone_jobs/.test(sql))!;
    expect(call[0]).toContain("mode = 'staging_create'");
    expect(call[0]).toContain('NOT (status = ANY');
    expect(call[1]).toEqual(['app_prod', ['completed', 'failed']]);
  });

  it('lets a create through when nothing is in flight', async () => {
    const res = await run();
    expect(res.ok).toBe(true);
    expect(mocks.startClone).toHaveBeenCalled();
  });

  it('still prefers ALREADY_EXISTS when the pair is linked, so the message names '
    + 'the staging app rather than a job id', async () => {
    mocks.getEnvironmentLink.mockResolvedValue({ staging_app_id: 'app_stg' });
    inFlightRows = [{ id: 'cj_first' }];
    const res = await run();
    expect(res).toEqual({ ok: false, code: 'ALREADY_EXISTS', stagingAppId: 'app_stg' });
  });
});
