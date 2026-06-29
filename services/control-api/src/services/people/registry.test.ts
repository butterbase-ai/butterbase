import { describe, it, expect, beforeEach } from 'vitest';
import { setPeopleAdapter, getPeopleAdapter } from './registry.js';
import type { PeopleAdapter } from './types.js';

describe('people registry', () => {
  beforeEach(() => setPeopleAdapter(null as unknown as PeopleAdapter));

  it('returns null when no adapter is registered', () => {
    expect(getPeopleAdapter()).toBeNull();
  });

  it('returns the registered adapter', () => {
    const stub = { searchPerson: async () => ({ data: { results: [] }, creditsConsumed: 0, requestId: null, status: 200, notFound: false }) } as PeopleAdapter;
    setPeopleAdapter(stub);
    expect(getPeopleAdapter()).toBe(stub);
  });
});
