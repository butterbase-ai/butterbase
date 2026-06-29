import { describe, it, expect, beforeEach } from 'vitest';
import { registerPeopleAdapter, getPeopleAdapter, unregisterPeopleAdapter, listRegisteredSlots } from './registry.js';
import type { PeopleAdapter } from './types.js';

describe('people registry', () => {
  beforeEach(() => { unregisterPeopleAdapter('primary'); unregisterPeopleAdapter('secondary'); });

  it('returns null when slot is empty', () => {
    expect(getPeopleAdapter('primary')).toBeNull();
    expect(getPeopleAdapter('secondary')).toBeNull();
  });

  it('registers and retrieves by slot', () => {
    const a = { searchPerson: async () => ({ data: { results: [], nextPage: null, totalResultCount: 0 }, creditsConsumed: 0, requestId: null, status: 200 }) } as PeopleAdapter;
    const b = { searchPerson: async () => ({ data: { results: [], nextPage: null, totalResultCount: 0 }, creditsConsumed: 0, requestId: null, status: 200 }) } as PeopleAdapter;
    registerPeopleAdapter('primary', a);
    registerPeopleAdapter('secondary', b);
    expect(getPeopleAdapter('primary')).toBe(a);
    expect(getPeopleAdapter('secondary')).toBe(b);
    expect(listRegisteredSlots()).toEqual(['primary', 'secondary']);
  });

  it('unregister removes', () => {
    const a = { searchPerson: async () => ({}) } as unknown as PeopleAdapter;
    registerPeopleAdapter('primary', a);
    unregisterPeopleAdapter('primary');
    expect(getPeopleAdapter('primary')).toBeNull();
  });
});
