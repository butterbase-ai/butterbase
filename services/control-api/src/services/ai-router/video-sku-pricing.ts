import type { VideoGenerationRequest } from './adapters/types.js';
import { normalizeOpenRouterVideoInputs } from './adapters/openrouter-video-inputs.js';

/** null means an older format; a null rate means a recognized but incomplete quote. */
export function normalizedVideoSkuRate(
  rawPricing: unknown,
  request: VideoGenerationRequest,
): { rateUsdPerSecond: number | null } | null {
  const skus = (rawPricing as { pricing_skus?: Record<string, unknown> } | undefined)?.pricing_skus;
  if (!skus || typeof skus !== 'object' || Array.isArray(skus)) return null;
  const cents = Object.keys(skus).some(key => /^(cents_per_second_(output|video_continuation)(_(480p|720p|1080p|2k|4k))?|cents_per_video_output_second_(480p|720p|1080p)|cents_per_image_input)$/.test(key));
  const h3 = request.model === 'minimax/hailuo-3';
  const h3Max = request.model === 'minimax/hailuo-3-max';
  if (!cents && !h3 && !h3Max) return null;
  const unknown = { rateUsdPerSecond: null };
  const seconds = request.duration ?? 10;
  if (!Number.isFinite(seconds) || seconds <= 0) return unknown;
  const number = (key: string): number | null => {
    const value = skus[key];
    if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const tier = request.resolution?.toLowerCase();
  const choose = (prefix: string) => {
    // A supplied tier has priority; malformed tier values cannot fall through.
    const exact = tier ? `${prefix}_${tier}` : undefined;
    if (exact && exact in skus) return number(exact);
    return number(prefix);
  };
  const inputs = normalizeOpenRouterVideoInputs(request);
  if (!inputs.ok || inputs.imageCount === null) return unknown;
  const videoInput = inputs.hasVideoInput;
  const imageCount = inputs.imageCount;
  let rate: number | null;
  let extra = 0;
  if (cents) {
    rate = videoInput ? choose('cents_per_second_video_continuation')
      : choose('cents_per_video_output_second') ?? choose('cents_per_second_output');
    if (rate === null || rate <= 0) return unknown;
    rate /= 100;
    if (imageCount && 'cents_per_image_input' in skus) {
      const inputRate = number('cents_per_image_input');
      if (inputRate === null) return unknown;
      extra = imageCount * inputRate / 100;
    }
  } else {
    // H3 input-video expenses are not represented by these output/image SKUs.
    // Require authoritative upstream usage instead of quoting a partial bill.
    if (videoInput) return unknown;
    rate = choose('duration_seconds');
    if (rate === null || rate <= 0) return unknown;
    if (h3 && imageCount > 5) {
      const inputRate = number('reference_images');
      if (inputRate === null) return unknown;
      extra = (imageCount - 5) * inputRate;
    }
  }
  // The existing router applies duration, hold headroom and charge policy.
  return { rateUsdPerSecond: rate + extra / seconds };
}
