import { describe, it, expect, vi } from 'vitest';
import {
  deriveStagingName, allocateStagingSubdomain, resolvePinnedStagingSubdomain,
  allocateDestSubdomainForJob,
} from './staging-naming.js';

/**
 * Two independent fake pools, because the whole point of the fix under test is
 * that the allocator consults BOTH planes. A single shared fake would let a
 * regression that dropped the control-plane query pass, since the runtime fake
 * would answer for it.
 *
 * `globalTaken` stands for control-plane `org_app_index.subdomain` (the
 * globally unique namespace, and the table the clone worker checks before it
 * inserts). `regionalTaken` stands for a runtime plane's `apps.subdomain`,
 * which is per-region and therefore cannot see a subdomain another region owns.
 */
function fakePools(opts: { globalTaken?: string[]; regionalTaken?: string[] } = {}) {
  const globalTaken = opts.globalTaken ?? [];
  const regionalTaken = opts.regionalTaken ?? [];
  const controlQuery = vi.fn(async (_sql: string, params: unknown[]) => ({
    rows: globalTaken.includes(params[0] as string) ? [{ app_id: 'app_other' }] : [],
  }));
  const runtimeQuery = vi.fn(async (_sql: string, params: unknown[]) => ({
    rows: regionalTaken.includes(params[0] as string) ? [{ subdomain: params[0] }] : [],
  }));
  return {
    pools: { controlDb: { query: controlQuery }, runtimeDb: { query: runtimeQuery } } as never,
    controlQuery,
    runtimeQuery,
  };
}

describe('deriveStagingName', () => {
  it('appends -staging', () => {
    expect(deriveStagingName('my-crm')).toBe('my-crm-staging');
  });

  it('normalises underscores, which apps.subdomain does not allow', () => {
    expect(deriveStagingName('my_crm')).toBe('my-crm-staging');
  });

  it('is idempotent so a staging app cannot become -staging-staging', () => {
    expect(deriveStagingName('my-crm-staging')).toBe('my-crm-staging');
  });

  it('truncates so the result fits the 63-char DNS label limit', () => {
    const long = 'a'.repeat(80);
    const out = deriveStagingName(long);
    expect(out.length).toBeLessThanOrEqual(63);
    expect(out.endsWith('-staging')).toBe(true);
  });

  it('truncates an overlong name that already ends in -staging, preserving the suffix', () => {
    const long = 'a'.repeat(80) + '-staging';
    const out = deriveStagingName(long);
    expect(out.length).toBeLessThanOrEqual(63);
    expect(out.endsWith('-staging')).toBe(true);
  });
});

describe('allocateStagingSubdomain', () => {
  it('returns the plain candidate when it is free', async () => {
    const { pools } = fakePools();
    expect(await allocateStagingSubdomain(pools, 'my-crm')).toBe('my-crm-staging');
  });

  it('falls back to a numbered suffix when taken', async () => {
    const { pools } = fakePools({ regionalTaken: ['my-crm-staging'] });
    expect(await allocateStagingSubdomain(pools, 'my-crm')).toBe('my-crm-staging-2');
  });

  // REGRESSION — the plane mismatch half of defect 1.
  //
  // Subdomains are a GLOBAL namespace enforced by user_app_index_subdomain_uniq
  // on the control-plane org_app_index. This function used to check only a
  // REGIONAL apps.subdomain, so a subdomain owned by an app in another region
  // was invisible to it: the API handed out a name that was already taken, and
  // the collision surfaced later inside the clone worker, after provisioning
  // had started. Nothing is in the regional fake here — if the control-plane
  // query were dropped, this returns "my-crm-staging" and the test fails.
  it('treats a subdomain held only in the control-plane index as taken', async () => {
    const { pools, controlQuery } = fakePools({ globalTaken: ['my-crm-staging'] });
    expect(await allocateStagingSubdomain(pools, 'my-crm')).toBe('my-crm-staging-2');
    expect(controlQuery).toHaveBeenCalled();
    expect(controlQuery.mock.calls[0][0]).toContain('org_app_index');
  });

  it('still treats a subdomain held only in the regional apps table as taken', async () => {
    const { pools, runtimeQuery } = fakePools({ regionalTaken: ['my-crm-staging'] });
    expect(await allocateStagingSubdomain(pools, 'my-crm')).toBe('my-crm-staging-2');
    expect(runtimeQuery).toHaveBeenCalled();
  });

  // REGRESSION — the spurious NO_SUBDOMAIN half of defect 1.
  //
  // The numbered ladder used to be the whole allocator, so ten taken names
  // produced a 409 refusing a create the worker (which appended a random
  // suffix) would have completed fine. It must now widen to a random suffix
  // before it gives up.
  it('widens to a random suffix rather than 409ing once the numbered ladder is exhausted', async () => {
    const ladder = [
      'my-crm-staging',
      ...Array.from({ length: 9 }, (_, i) => `my-crm-staging-${i + 2}`),
    ];
    const { pools } = fakePools({ globalTaken: ladder });
    const out = await allocateStagingSubdomain(pools, 'my-crm');
    expect(ladder).not.toContain(out);
    expect(out.startsWith('my-crm-staging-')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(63);
  });

  it('throws rather than looping forever when every candidate is taken', async () => {
    // Every query answers "taken", so both the ladder and the random widening
    // are exhausted.
    const pools = {
      controlDb: { query: vi.fn(async () => ({ rows: [{ app_id: 'x' }] })) },
      runtimeDb: { query: vi.fn(async () => ({ rows: [] })) },
    } as never;
    await expect(allocateStagingSubdomain(pools, 'my-crm'))
      .rejects.toThrow(/no free subdomain/i);
  });
});

describe('resolvePinnedStagingSubdomain', () => {
  // REGRESSION — the core of defect 1. The value start-staging allocated and
  // reported to the caller must be the value that lands, not a starting point
  // for a second derivation.
  it('applies the pinned value verbatim when it is still free', async () => {
    const { pools } = fakePools();
    expect(await resolvePinnedStagingSubdomain(pools, 'my-crm-staging'))
      .toEqual({ subdomain: 'my-crm-staging', reallocated: false });
  });

  it('re-allocates through the same allocator, without double-suffixing, when it was taken', async () => {
    const { pools } = fakePools({ globalTaken: ['my-crm-staging'] });
    const out = await resolvePinnedStagingSubdomain(pools, 'my-crm-staging');
    // Seeded from the pinned value, and deriveStagingName is idempotent, so the
    // ladder continues at -2 rather than producing "my-crm-staging-staging".
    expect(out).toEqual({ subdomain: 'my-crm-staging-2', reallocated: true });
  });
});

describe('allocateDestSubdomainForJob — the clone worker one decision', () => {
  const logger = { warn: vi.fn() };

  // REGRESSION for defect 1, worker half.
  //
  // Before the fix this branch did not exist: a staging_create job fell into
  // the derive-from-destName-plus-random-suffix loop below, so the app got
  // something like "my-crm-staging-48213" while the API had already told the
  // caller "my-crm-staging". This test fails against that code — the loop
  // never consults the pinned value at all.
  it('applies a pinned staging subdomain verbatim and never derives from the name', async () => {
    const { pools, controlQuery } = fakePools();
    const out = await allocateDestSubdomainForJob({
      job: { mode: 'staging_create', dest_subdomain: 'my-crm-staging' },
      pools,
      baseSlug: 'staging-of-my-crm',
      logger,
    });
    expect(out).toEqual({ subdomain: 'my-crm-staging' });
    // The name-derived slug must never appear in any lookup: if it did, the
    // worker would still be running its own second allocator.
    for (const call of controlQuery.mock.calls) {
      expect(call[1]).not.toContain('staging-of-my-crm');
    }
  });

  it('reports the divergence rather than silently substituting when the pin was taken', async () => {
    const { pools } = fakePools({ globalTaken: ['my-crm-staging'] });
    const out = await allocateDestSubdomainForJob({
      job: { mode: 'staging_create', dest_subdomain: 'my-crm-staging' },
      pools,
      baseSlug: 'staging-of-my-crm',
      logger,
    });
    expect(out).toEqual({ subdomain: 'my-crm-staging-2', reallocatedFrom: 'my-crm-staging' });
  });

  // The other half of the contract: ordinary clones and template updates must
  // be byte-identical to the pre-fix behaviour.
  it('keeps the derive-from-name path for an ordinary clone', async () => {
    const { pools } = fakePools();
    const out = await allocateDestSubdomainForJob({
      job: { mode: 'clone', dest_subdomain: null },
      pools,
      baseSlug: 'clone-of-butter-support',
      logger,
    });
    expect(out).toEqual({ subdomain: 'clone-of-butter-support' });
  });

  it('appends a random suffix for an ordinary clone whose slug is taken', async () => {
    const { pools } = fakePools({ globalTaken: ['clone-of-butter-support'] });
    const out = await allocateDestSubdomainForJob({
      job: { mode: 'clone', dest_subdomain: null },
      pools,
      baseSlug: 'clone-of-butter-support',
      logger,
    });
    expect(out.subdomain).toMatch(/^clone-of-butter-support-\d+$/);
    expect(out.reallocatedFrom).toBeUndefined();
  });

  it('falls back to the derive-from-name path for a legacy staging job with no pin', async () => {
    const { pools } = fakePools();
    const out = await allocateDestSubdomainForJob({
      job: { mode: 'staging_create', dest_subdomain: null },
      pools,
      baseSlug: 'my-crm-staging',
      logger,
    });
    expect(out).toEqual({ subdomain: 'my-crm-staging' });
  });
});
