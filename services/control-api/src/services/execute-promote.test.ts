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
import { filterAdditive } from './schema-additive-filter.js';
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
  // Default to the FINAL attempt so the ordinary tests below see terminal
  // behaviour; the retry-contract tests override these two explicitly.
  attempt: 3,
  maxAttempts: 3,
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
    disabledTriggersInserted: [],
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

  // Asserted by IDENTITY, not expect.any(Function): a no-op filter would
  // satisfy a shape check while quietly letting DROP TABLE onto production.
  it('replays schema staging -> prod with filterAdditive itself', async () => {
    await executePromote(deps, job);
    expect(mocks.replaySchema).toHaveBeenCalledWith(
      deps.stagingPool, deps.prodPool, 'app_prod',
      expect.anything(), { filter: filterAdditive },
    );
  });

  it('replays RLS add-only from staging to prod app DBs', async () => {
    await executePromote(deps, job);
    expect(mocks.replayRls).toHaveBeenCalledWith(deps.stagingPool, deps.prodPool, expect.anything());
  });

  it('surfaces genuine RLS failures separately from pre-existing policies', async () => {
    mocks.replayRls.mockResolvedValue({
      replayed: 1,
      warnings: ['RLS policy orders.owner_read failed: policy "owner_read" already exists', 'real problem'],
    });
    await executePromote(deps, job);
    expect(mocks.appendCloneJobWarnings).toHaveBeenCalledWith(
      deps.controlDb, 'job_p1', ['real problem'],
    );
  });

  // Fix round 2, item 3. replayRls only CREATEs, so a policy production
  // already has is left at its old definition. Filtering that away — correct
  // for a template update, where the fork's policies are the fork owner's —
  // would tell a promoting user their tightened policy is live when it is not.
  it('tells the user which RLS policies already existed and did not travel', async () => {
    mocks.replayRls.mockResolvedValue({
      replayed: 0,
      warnings: [
        'RLS policy orders.owner_read failed: policy "owner_read" for table "orders" already exists',
        'RLS policy invoices.tenant_scope failed: policy "tenant_scope" for table "invoices" already exists',
      ],
    });
    await executePromote(deps, job);

    const surfaced = mocks.appendCloneJobWarnings.mock.calls.map((c) => c[2]).flat();
    const notice = surfaced.find((w: string) => /already exist/i.test(w));
    expect(notice).toBeDefined();
    // Names each policy, so the user knows exactly what to reapply by hand.
    expect(notice).toContain('orders.owner_read');
    expect(notice).toContain('invoices.tenant_scope');
    // And is explicit that the staging edit did not reach production.
    expect(notice).toMatch(/did NOT reach production/);
  });

  it('says nothing about pre-existing policies when there are none', async () => {
    mocks.replayRls.mockResolvedValue({ replayed: 3, warnings: [] });
    await executePromote(deps, job);
    const surfaced = mocks.appendCloneJobWarnings.mock.calls.map((c) => c[2]).flat();
    expect(surfaced.some((w: string) => /already exist/i.test(w))).toBe(false);
  });

  it('replays functions on the RUNTIME pools, overwriting existing bodies', async () => {
    await executePromote(deps, job);
    expect(mocks.replayFunctions).toHaveBeenCalledWith(
      deps.runtimeDb, deps.runtimeDb, 'app_staging', 'app_prod', 'user_1',
      expect.anything(),
      expect.objectContaining({ overwriteExisting: true, destAppOwnerId: 'owner_prod' }),
    );
  });

  // Fix round 2, item 1 — the critical one. isolateStagingApp disables every
  // cron trigger on a staging app; without this flag the trigger upsert copies
  // that `enabled = false` onto the customer's LIVE production app and
  // silently stops every scheduled function.
  it('preserves production trigger enabled state when promoting functions', async () => {
    await executePromote(deps, job);
    expect(mocks.replayFunctions).toHaveBeenCalledWith(
      deps.runtimeDb, deps.runtimeDb, 'app_staging', 'app_prod', 'user_1',
      expect.anything(),
      expect.objectContaining({ preserveDestinationTriggerEnabled: true }),
    );
  });

  // Fix round 3. preserveDestinationTriggerEnabled protects triggers production
  // ALREADY has. A cron trigger added in staging has no production counterpart,
  // so it is INSERTed carrying isolation's `enabled = false` — created on
  // production, never fires. Kept disabled deliberately; never kept quiet.
  it('warns when a staging-only cron trigger lands on production disabled', async () => {
    mocks.replayFunctions.mockResolvedValue({
      count: 1, warnings: [], unfilledEnvVars: {}, overrideFilledFunctions: {},
      disabledTriggersInserted: ['nightly-billing.cron'],
    });
    await executePromote(deps, job);

    const surfaced = mocks.appendCloneJobWarnings.mock.calls.map((c) => c[2]).flat();
    const notice = surfaced.find((w: string) => /NOT scheduled to run/.test(w));
    expect(notice).toBeDefined();
    expect(notice).toContain('nightly-billing.cron');
    // Must say the trigger EXISTS on production but will not fire, and that
    // enabling it is the owner's move — not merely that something was skipped.
    expect(notice).toMatch(/created on production/);
    expect(notice).toMatch(/Enable each one on the production app/);
  });

  it('says nothing about disabled triggers when none were inserted', async () => {
    await executePromote(deps, job);
    const surfaced = mocks.appendCloneJobWarnings.mock.calls.map((c) => c[2]).flat();
    expect(surfaced.some((w: string) => /NOT scheduled to run/.test(w))).toBe(false);
  });

  it('replays durable objects on the runtime pools without re-minting prod secrets', async () => {
    await executePromote(deps, job);
    expect(mocks.replayDurableObjectsForClone).toHaveBeenCalledWith(
      deps.runtimeDb, deps.runtimeDb, deps.controlDb,
      'app_staging', 'app_prod', 'user_1',
    );
  });

  // Fix round 2, item 2: replayNonSecretConfig calls replayIntegrations
  // internally, but the registry declares `integrations` non-promotable.
  // Skipping it explicitly is what connects the stated policy to the executed
  // behaviour — previously nothing moved only because staging's rows happen to
  // be disabled and the source query filters on `enabled = true`.
  it('replays config insert-only AND skips integrations, per the registry', async () => {
    await executePromote(deps, job);
    expect(mocks.replayNonSecretConfig).toHaveBeenCalledWith(
      deps.runtimeDb, deps.runtimeDb, 'app_staging', 'app_prod',
      expect.anything(), { insertOnly: true, skipIntegrations: true },
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

  it('fails the job and rethrows when a step throws on the FINAL attempt', async () => {
    mocks.replaySchema.mockRejectedValueOnce(new Error('boom'));
    await expect(executePromote({ ...deps, attempt: 3, maxAttempts: 3 }, job)).rejects.toThrow('boom');
    expect(mocks.setCloneJobStatus).toHaveBeenLastCalledWith(
      deps.controlDb, 'job_p1', expect.objectContaining({ status: 'failed', error_message: 'boom' }),
    );
    expect(mocks.touchEnvironmentTimestamp).not.toHaveBeenCalled();
  });

  // The test that proves the gate exists. 'failed' is terminal, and the
  // re-entry guard short-circuits on terminal statuses — so marking it here
  // would turn attempts 2 and 3 into silent no-ops and permanently fail a
  // promote that a connection blip would otherwise have let succeed.
  it('does NOT mark the job failed on a non-final attempt, so the retry can re-enter', async () => {
    mocks.replaySchema.mockRejectedValueOnce(new Error('blip'));
    await expect(executePromote({ ...deps, attempt: 1, maxAttempts: 3 }, job)).rejects.toThrow('blip');

    const statuses = mocks.setCloneJobStatus.mock.calls.map((c) => c[2].status);
    expect(statuses).not.toContain('failed');
    // The error is still recorded, just without going terminal.
    expect(mocks.setCloneJobStatus).toHaveBeenLastCalledWith(
      deps.controlDb, 'job_p1', { error_message: 'blip' },
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
