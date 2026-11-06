import { describe, expect, it } from 'vitest';
import { isMediaModelRoutable } from './model-support.js';
import type { CatalogEntry } from './catalog.js';
import type { RouterAdapter } from './adapters/types.js';
import type { RouterName } from './normalize.js';

const entry = (modality: 'image' | 'video' | 'chat'): CatalogEntry => ({
  canonicalId: 'example/media', displayName: 'Example', updatedAt: '', routers: [{
    name: 'openrouter', upstreamId: 'example/media', modality,
    promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0,
  }],
});
const image = { submitImage: async () => ({}), getSupportedImageParams: () => ({ topLevel: new Set(), provider: new Set() }) };
const video = { submitVideo: async () => ({}), pollVideo: async () => ({}), fetchVideoContent: async () => ({}) };
function routable(e: CatalogEntry, adapter: object, enabled: RouterName[] = ['openrouter'], slot: RouterName = 'openrouter') {
  return isMediaModelRoutable(e, new Map([[slot, adapter as RouterAdapter]]), new Set(enabled));
}

describe('media model availability', () => {
  it('excludes an image model when its adapter does not claim its canonical ID', () => {
    expect(routable(entry('image'), { ...image, getSupportedImageParams: () => null })).toBe(false);
  });
  it('includes an image model only when its advertised enabled adapter can submit it', () => {
    expect(routable(entry('image'), image)).toBe(true);
    expect(routable(entry('image'), { getSupportedImageParams: image.getSupportedImageParams })).toBe(false);
  });
  it('does not borrow capability from a disabled, missing or non-advertised adapter', () => {
    expect(routable(entry('image'), image, [])).toBe(false);
    expect(routable(entry('image'), {})).toBe(false);
    expect(routable(entry('image'), image, ['provider-secondary'], 'provider-secondary')).toBe(false);
  });
  it('requires video submission, polling and content retrieval on the same provider', () => {
    expect(routable(entry('video'), video)).toBe(true);
    for (const missing of ['submitVideo', 'pollVideo', 'fetchVideoContent']) {
      expect(routable(entry('video'), { ...video, [missing]: undefined })).toBe(false);
    }
  });
  it('retains other modalities without applying the media policy', () => {
    expect(routable(entry('chat'), {}, [])).toBe(true);
  });
});
