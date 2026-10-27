import { describe, expect, it } from 'vitest';
import { estimateVideoCostUsd, billedVideoCostUsd } from './router.js';
import type { CatalogEntry } from './catalog.js';
import type { VideoGenerationRequest } from './adapters/types.js';

function entry(skus: Record<string, string>, model = 'example/video'): CatalogEntry {
  return { canonicalId: model, displayName: model, updatedAt: '', routers: [{ name: 'openrouter', upstreamId: model,
    modality: 'video', promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0,
    rawPricing: { source: '/videos/models', pricing_skus: skus } }] };
}
const request = (model = 'example/video', extra: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest => ({
  model, prompt: 'A test scene', duration: 5, resolution: '720p', ...extra,
});

describe('video SKU currencies and modes', () => {
  it('converts cents output rates exactly once and keeps reservation buffer out of billing', () => {
    const e = entry({ cents_per_second_output: '20', cents_per_second_output_720p: '20', cents_per_second_output_1080p: '40' });
    expect(estimateVideoCostUsd(e, request())).toBeCloseTo(1.2);
    expect(billedVideoCostUsd(e, request(), 'openrouter', true)).toBe(1);
    expect(billedVideoCostUsd(e, request(undefined, { resolution: '1080p' }), 'openrouter', true)).toBe(2);
  });
  it('uses video continuation rates rather than ordinary output rates', () => {
    const e = entry({ cents_per_second_output_720p: '20', cents_per_second_video_continuation_720p: '60' });
    const req = request(undefined, { input_references: [{ type: 'video_url', video_url: { url: 'https://media.example/ref.mp4' } }] });
    expect(billedVideoCostUsd(e, req, 'openrouter', true)).toBe(3);
  });
  it('adds input image charges without counting mirrored frame/input collections twice', () => {
    const e = entry({ cents_per_video_output_second_720p: '20', cents_per_image_input: '2' });
    const req = request(undefined, { input_images: ['https://images.example/a'],
      frame_images: [{ type: 'image_url', image_url: { url: 'https://images.example/a' }, frame_type: 'first_frame' }] });
    expect(billedVideoCostUsd(e, req, 'openrouter', true)).toBe(1.02);
    expect(estimateVideoCostUsd(e, req)).toBeCloseTo(1.224);
  });
  it('retains H3 dollar pricing and its documented five free image references', () => {
    const model = 'minimax/hailuo-3'; const e = entry({ duration_seconds: '0.20', reference_images: '0.02' }, model);
    expect(billedVideoCostUsd(e, request(model, { input_images: Array(5).fill('https://images.example/a') }), 'openrouter', true)).toBe(1);
    expect(billedVideoCostUsd(e, request(model, { input_images: Array(7).fill('https://images.example/a') }), 'openrouter', true)).toBe(1.04);
  });
  it('counts input images when the optional frame collection is empty', () => {
    const e = entry({ cents_per_video_output_second_720p: '20', cents_per_image_input: '2' });
    expect(billedVideoCostUsd(e, request(undefined, { frame_images: [], input_images: ['https://images.example/a'] }), 'openrouter', true)).toBe(1.02);
  });
  it('selects the requested H3 Max resolution without borrowing a more expensive tier', () => {
    const model = 'minimax/hailuo-3-max'; const e = entry({ duration_seconds: '0.20', duration_seconds_480p: '0.10', duration_seconds_768p: '0.20' }, model);
    expect(billedVideoCostUsd(e, request(model, { resolution: '480p' }), 'openrouter', true)).toBe(0.5);
  });
  it('preserves the legacy maximum-rate policy for older dollar-shaped models', () => {
    const e = entry({ duration_seconds_480p: '0.10', duration_seconds_720p: '0.20' });
    expect(billedVideoCostUsd(e, request(undefined, { resolution: '480p' }), 'openrouter', true)).toBe(1);
  });
  it('leaves unknown or malformed SKU formats estimated instead of inventing a charge', () => {
    for (const skus of [{ mystery_units: '7' }, { cents_per_second_output_720p: '20garbage' }]) {
      const e = entry(skus);
      expect(estimateVideoCostUsd(e, request())).toBe(3);
      expect(billedVideoCostUsd(e, request(), 'openrouter', true)).toBeNull();
    }
  });
  it('does not price an input video at an ordinary output rate without a continuation contract', () => {
    const e = entry({ cents_per_second_output_720p: '20' });
    expect(billedVideoCostUsd(e, request(undefined, { input_references: [{ type: 'video_url', video_url: { url: 'https://media.example/a.mp4' } }] }), 'openrouter', true)).toBeNull();
  });
});
