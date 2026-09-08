import { describe, it, expect, vi } from 'vitest';
import { deriveStagingName, allocateStagingSubdomain } from './staging-naming.js';

function fakeDb(taken: string[]) {
  return {
    query: vi.fn(async (_sql: string, params: unknown[]) => {
      const candidate = (params[0] as string);
      return { rows: taken.includes(candidate) ? [{ subdomain: candidate }] : [] };
    }),
  } as never;
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
});

describe('allocateStagingSubdomain', () => {
  it('returns the plain candidate when it is free', async () => {
    expect(await allocateStagingSubdomain(fakeDb([]), 'my-crm')).toBe('my-crm-staging');
  });

  it('falls back to a numbered suffix when taken', async () => {
    expect(await allocateStagingSubdomain(fakeDb(['my-crm-staging']), 'my-crm'))
      .toBe('my-crm-staging-2');
  });

  it('throws rather than looping forever when every candidate is taken', async () => {
    const all = ['my-crm-staging', ...Array.from({ length: 9 }, (_, i) => `my-crm-staging-${i + 2}`)];
    await expect(allocateStagingSubdomain(fakeDb(all), 'my-crm')).rejects.toThrow(/no free subdomain/i);
  });
});
