import { describe, it, expect, beforeEach } from 'vitest';
import { registerActorProvider, getActorProvider, _resetRegistryForTests } from './registry.js';
import { ProviderUnavailableError } from './types.js';
import type { ActorProvider } from './types.js';

const stub: ActorProvider = {
  key: 'meetings',
  recordingUsdPerSecond: 0.0001388,
  transcriptionUsdPerSecond: 0.0000416,
  start: async () => { throw new Error('not used'); },
  get: async () => { throw new Error('not used'); },
  stop: async () => { throw new Error('not used'); },
  list: async () => { throw new Error('not used'); },
};

describe('actor-providers registry', () => {
  beforeEach(() => _resetRegistryForTests());

  it('throws ProviderUnavailableError when no adapter registered', () => {
    expect(() => getActorProvider('meetings')).toThrow(ProviderUnavailableError);
  });

  it('returns the registered adapter', () => {
    registerActorProvider(stub);
    expect(getActorProvider('meetings')).toBe(stub);
  });

  it('replaces on re-register (last wins)', () => {
    registerActorProvider(stub);
    const stub2 = { ...stub, recordingUsdPerSecond: 0.0002 };
    registerActorProvider(stub2);
    expect(getActorProvider('meetings').recordingUsdPerSecond).toBe(0.0002);
  });
});
