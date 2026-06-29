import type { EnrichLayerAdapter } from './types.js';

let adapter: EnrichLayerAdapter | null = null;

export function setEnrichLayerAdapter(a: EnrichLayerAdapter | null): void {
  adapter = a;
}

export function getEnrichLayerAdapter(): EnrichLayerAdapter | null {
  return adapter;
}
