import { describe, it, expect, beforeEach } from 'vitest';
import { setEnrichLayerAdapter, getEnrichLayerAdapter } from './registry.js';
import type { EnrichLayerAdapter } from './types.js';

describe('enrichlayer registry', () => {
  beforeEach(() => setEnrichLayerAdapter(null as unknown as EnrichLayerAdapter));

  it('returns null when no adapter is registered', () => {
    expect(getEnrichLayerAdapter()).toBeNull();
  });

  it('returns the registered adapter', () => {
    const stub = { searchPerson: async () => ({ data: { results: [] }, creditsConsumed: 0, requestId: null, status: 200, notFound: false }) } as EnrichLayerAdapter;
    setEnrichLayerAdapter(stub);
    expect(getEnrichLayerAdapter()).toBe(stub);
  });
});
