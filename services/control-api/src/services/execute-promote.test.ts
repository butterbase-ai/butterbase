/**
 * executePromote applies a staging app's state onto a LIVE production app.
 * These tests pin the properties that keep that safe: seed data never travels,
 * schema is additive-filtered, config is insert-only, DO env secrets are never
 * re-minted, every promotable step has a real arm, and an unknown step throws
 * rather than being silently skipped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReplayStep } from './replay-registry.js';

const mocks = vi.hoisted(() => ({
  replaySchema: vi.fn(),
  replayRls: vi.fn(),
  replayFunctions: vi.fn(),
  replayNonSecretConfig: vi.fn(),
  replaySeedData: vi.fn(),
  replayDurableObjectsForClone: vi.fn(),
  setCloneJobStatus: vi.fn(),
  appendCloneJobWarnings: vi.fn(),
  touchEnvironmentTimestamp: vi.fn(),
  extraStep: null as ReplayStep | null,
}));

vi.mock('./clone-replay.js', () => ({
  replaySchema: mocks.replaySchema,
  replayRls: mocks.replayRls,
  replayFunctions: mocks.replayFunctions,
  replayNonSecretConfig: mocks.replayNonSecretConfig,
  replaySeedData: mocks.replaySeedData,
}));
vi.mock('./durable-objects.service.js', () => ({
  replayDurableObjectsForClone: mocks.replayDurableObjectsForClone,
}));
vi.mock('./clone-jobs.js', () => ({
  setCloneJobStatus: mocks.setCloneJobStatus,
  appendCloneJobWarnings: mocks.appendCloneJobWarnings,
}));
vi.mock('./app-environments.js', () => ({
  touchEnvironmentTimestamp: mocks.touchEnvironmentTimestamp,
}));
// The real registry drives the loop — that is the point of the registry — but a
// test can append a bogus row to prove the default arm throws.
vi.mock('./replay-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./replay-registry.js')>();
  return {
    ...actual,
    promotableSteps: () =>
      mocks.extraStep ? [...actual.promotableSteps(), mocks.extraStep] : actual.promotableSteps(),
  };
});

import { executePromote, type PromoteDeps } from './execute-promote.js';
import { promotableSteps } from './replay-registry.js';
import type { CloneJob } from './clone-jobs.js';

const job = {
  id: 'job_p1',
  mode: 'promote',
  source_app_id: 'app_staging',
  dest_app_id: 'app_prod',
  requested_by_user_id: 'user_1',
} as unknown as CloneJob;

const controlQuery = vi.fn().mockResolvedValue({ rows: [] });

const deps: PromoteDeps = {
  controlDb: { tag: 'control', query: controlQuery } as never,
  runtimeDb: { tag: 'runtime' } as never,
  stagingPool: { tag: 'staging' } as never,
  prodPool: { tag: 'prod' } as never,
  prodOwnerId: 'owner_prod',
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.extraStep = null;
  controlQuery.mockResolvedValue({ rows: [] });
  mocks.setCloneJobStatus.mockResolvedValue(undefined);
  mocks.appendCloneJobWarnings.mockResolvedValue(undefined);
  mocks.touchEnvironmentTimestamp.mockResolvedValue(undefined);
  mocks.replaySchema.mockResolvedValue(undefined);
  mocks.replayRls.mockResolvedValue({ replayed: 0, warnings: [] });
  mocks.replayFunctions.mockResolvedValue({
    count: 0, warnings: [], unfilledEnvVars: {}, overrideFilledFunctions: {},
  });
  mocks.replayNonSecretConfig.mockResolvedValue({ warnings: [] });
  mocks.replayDurableObjectsForClone.mockResolvedValue({
    cloned: [], do_env_keys: [], auto_minted_keys: [], override_filled_keys: [],
  });
});

describe('executePromote', () => {
  it('never replays seed data into production', async () => {
    await executePromote(deps, job);
    expect(mocks.replaySeedData).not.toHaveBeenCalled();
  });

  it('replays schema staging -> prod with the additive filter', async () => {
    await executePromote(deps, job);
    expect(mocks.replaySchema).toHaveBeenCalledWith(
      deps.stagingPool, deps.prodPool, 'app_prod',
      expect.anything(), expect.objectContaining({ filter: expect.any(Function) }),
    );
  });

  it('replays RLS add-only from staging to prod app DBs', async () => {
    await executePromote(deps, job);
    expect(mocks.replayRls).toHaveBeenCalledWith(deps.stagingPool, deps.prodPool, expect.anything());
  });

  it('filters "already exists" out of the RLS warnings it surfaces', async () => {
    mocks.replayRls.mockResolvedValue({
      replayed: 1, warnings: ['policy "p" already exists', 'real problem'],
    });
    await executePromote(deps, job);
    expect(mocks.appendCloneJobWarnings).toHaveBeenCalledWith(
      deps.controlDb, 'job_p1', ['real problem'],
    );
  });

  it('replays functions on the RUNTIME pools, overwriting existing bodies', async () => {
    await executePromote(deps, job);
    expect(mocks.replayFunctions).toHaveBeenCalledWith(
      deps.runtimeDb, deps.runtimeDb, 'app_staging', 'app_prod', 'user_1',
      expect.anything(),
      expect.objectContaining({ overwriteExisting: true, destAppOwnerId: 'owner_prod' }),
    );
  });

  it('replays durable objects on the runtime pools without re-minting prod secrets', async () => {
    await executePromote(deps, job);
    expect(mocks.replayDurableObjectsForClone).toHaveBeenCalledWith(
      deps.runtimeDb, deps.runtimeDb, deps.controlDb,
      'app_staging', 'app_prod', 'user_1',
    );
  });

  it('replays config insert-only so prod OAuth/Composio secrets survive', async () => {
    await executePromote(deps, job);
    expect(mocks.replayNonSecretConfig).toHaveBeenCalledWith(
      deps.runtimeDb, deps.runtimeDb, 'app_staging', 'app_prod',
      expect.anything(), { insertOnly: true },
    );
  });

  it('walks every promotable status from the registry', async () => {
    await executePromote(deps, job);
    const statuses = mocks.setCloneJobStatus.mock.calls.map((c) => c[2].status);
    for (const step of promotableSteps()) {
      expect(statuses).toContain(step.status);
    }
  });

  it('records the promote time on the environment link', async () => {
    await executePromote(deps, job);
    expect(mocks.touchEnvironmentTimestamp)
      .toHaveBeenCalledWith(deps.runtimeDb, 'app_prod', 'last_promoted_at');
  });

  it('marks the job completed', async () => {
    await executePromote(deps, job);
    expect(mocks.setCloneJobStatus).toHaveBeenLastCalledWith(
      deps.controlDb, 'job_p1', expect.objectContaining({ status: 'completed' }),
    );
  });

  it('fails the job and rethrows when a step throws', async () => {
    mocks.replaySchema.mockRejectedValueOnce(new Error('boom'));
    await expect(executePromote(deps, job)).rejects.toThrow('boom');
    expect(mocks.setCloneJobStatus).toHaveBeenLastCalledWith(
      deps.controlDb, 'job_p1', expect.objectContaining({ status: 'failed', error_message: 'boom' }),
    );
    expect(mocks.touchEnvironmentTimestamp).not.toHaveBeenCalled();
  });

  it('throws on a promotable registry step with no arm here', async () => {
    mocks.extraStep = { name: 'quantum_flux', status: 'replaying_config', promotable: true };
    await expect(executePromote(deps, job)).rejects.toThrow(/quantum_flux/);
    expect(mocks.setCloneJobStatus).toHaveBeenLastCalledWith(
      deps.controlDb, 'job_p1', expect.objectContaining({ status: 'failed' }),
    );
  });

  it('refuses a job with no dest_app_id', async () => {
    const bad = { ...job, dest_app_id: null } as unknown as CloneJob;
    await expect(executePromote(deps, bad)).rejects.toThrow(/dest_app_id/);
    expect(mocks.replaySchema).not.toHaveBeenCalled();
  });
});
