import type { VideoGenerationRequest } from './types.js';

type NormalizedInputs = { ok: true; request: VideoGenerationRequest; imageCount: number | null; hasVideoInput: boolean }
  | { ok: false; error: string };
function imageUrl(part: Record<string, unknown>): string | null {
  const value = part.image_url;
  return part.type === 'image_url' && value && typeof value === 'object'
    && typeof (value as { url?: unknown }).url === 'string' ? (value as { url: string }).url : null;
}

/** Submission and pricing must agree on the exact native media slots. */
export function normalizeOpenRouterVideoInputs(request: VideoGenerationRequest): NormalizedInputs {
  const { input_images: canonical, ...body } = request;
  if (canonical?.length) {
    if (canonical.length > 2) return { ok: false, error: 'More than two input_images requires explicit input_references or frame_images' };
    const derived = canonical.map((url, i) => ({ type: 'image_url', image_url: { url }, frame_type: i === 0 ? 'first_frame' : 'last_frame' }));
    if (body.frame_images?.length) {
      const matches = body.frame_images.length === derived.length && body.frame_images.every((part, i) =>
        imageUrl(part) === canonical[i] && part.frame_type === derived[i].frame_type);
      if (!matches) return { ok: false, error: 'Conflicting input_images and frame_images; use one canonical image collection' };
    } else body.frame_images = derived;
  }
  if (body.input_references) {
    body.input_references = body.input_references.map(part => typeof part === 'string'
      ? { type: 'image_url', image_url: { url: part } } : part);
  }
  let imageCount: number | null = 0;
  let hasVideoInput = false;
  for (const part of body.frame_images ?? []) {
    if (imageUrl(part) !== null) imageCount++;
    else imageCount = null;
    if (imageCount === null) break;
  }
  for (const part of body.input_references ?? []) {
    if (typeof part === 'string') { imageCount = null; continue; }
    if (part.type === 'video_url') hasVideoInput = true;
    else if (part.type !== 'audio_url') {
      if (imageUrl(part) !== null && imageCount !== null) imageCount++;
      else imageCount = null;
    }
  }
  return { ok: true, request: body, imageCount, hasVideoInput };
}
