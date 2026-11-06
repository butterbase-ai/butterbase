import type { ImageGenerationRequest, ImageSupportedParams } from './types.js';

interface ImageModel { endpoint: 'images' | 'images/generations'; params: ImageSupportedParams }
interface Contract {
  references: number; images: number; ratios: readonly string[]; sizes?: readonly string[];
  qualities?: readonly string[]; backgrounds?: readonly string[]; compression?: boolean;
}
const legacy: ImageModel = { endpoint: 'images/generations', params: {
  topLevel: new Set(['size', 'n', 'seed', 'input_images']), provider: new Set(),
} };
const legacyIds = new Set([
  'openai/gpt-image-2', 'openai/gpt-image-1', 'openai/gpt-image-1-mini',
  'google/gemini-3.1-flash-lite-image', 'google/gemini-3.1-flash-image', 'google/gemini-3-pro-image',
  'black-forest-labs/flux.2-pro', 'black-forest-labs/flux.2-max',
  'black-forest-labs/flux.2-flex', 'black-forest-labs/flux.2-klein-4b',
]);

function model(contract: Contract): ImageModel {
  const provider = new Set<string>([...(contract.qualities ? ['quality'] : []),
    ...(contract.backgrounds ? ['background'] : []), ...(contract.compression ? ['output_compression'] : [])]);
  const topLevel = new Set(['size', 'aspect_ratio', 'n', 'input_images']);
  return { endpoint: 'images', params: { topLevel, provider, validate(request: ImageGenerationRequest) {
    const issue = (param: string, message: string) => ({ param, message });
    for (const key of ['size', 'aspect_ratio', 'n', 'seed', 'negative_prompt', 'input_images', 'mask'] as const) {
      if (request[key] !== undefined && !topLevel.has(key)) return issue(key, 'Parameter is not supported by this model');
    }
    for (const key of Object.keys(request.provider ?? {})) {
      if (!provider.has(key)) return issue(`provider.${key}`, 'Provider parameter is not supported by this model');
    }
    if (request.n !== undefined && (!Number.isInteger(request.n) || request.n < 1 || request.n > contract.images)) return issue('n', `Image count must be between 1 and ${contract.images}`);
    if ((request.input_images?.length ?? 0) > contract.references) return issue('input_images', `At most ${contract.references} reference images are supported`);
    if (request.aspect_ratio !== undefined && !contract.ratios.includes(request.aspect_ratio)) return issue('aspect_ratio', 'Aspect ratio is not supported by this model');
    if (request.size !== undefined) {
      if (contract.sizes) {
        if (!contract.sizes.includes(request.size)) return issue('size', `Use a supported size tier: ${contract.sizes.join(', ')}`);
      } else if (request.size !== 'auto') {
        const match = /^(\d+)x(\d+)$/.exec(request.size);
        const width = Number(match?.[1]), height = Number(match?.[2]);
        if (!match || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
          || width <= 0 || height <= 0 || width % 16 || height % 16 || Math.max(width, height) > 3840
          || width * height < 655360 || width * height > 8294400 || Math.max(width, height) > 3 * Math.min(width, height)) {
          return issue('size', 'Use WIDTHxHEIGHT with multiples of 16, at most 3840 per edge, 655360–8294400 pixels and at most 3:1 aspect ratio');
        }
        if (request.aspect_ratio && request.aspect_ratio !== 'auto') {
          const [rw, rh] = request.aspect_ratio.split(':').map(Number);
          if (width * rh !== height * rw) return issue('aspect_ratio', 'Aspect ratio must match explicit size dimensions');
        }
      }
    }
    const options = request.provider ?? {};
    if (options.quality !== undefined && !contract.qualities?.includes(options.quality as string)) return issue('provider.quality', 'Quality is not supported by this model');
    if (options.background !== undefined && !contract.backgrounds?.includes(options.background as string)) return issue('provider.background', 'Background is not supported by this model');
    if (options.output_compression !== undefined && (typeof options.output_compression !== 'number' || !Number.isInteger(options.output_compression) || options.output_compression < 0 || options.output_compression > 100)) return issue('provider.output_compression', 'Compression must be an integer between 0 and 100');
    return null;
  } } };
}

// Explicitly reviewed Images API contracts. Discovery alone never enables an ID.
const openai = model({ references: 16, images: 10,
  ratios: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', 'auto'],
  qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
  backgrounds: ['auto', 'transparent', 'opaque'], compression: true });
const grokBase: Contract = { references: 3, images: 1, sizes: ['1K', '2K'],
  ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '9:19.5', '19.5:9', '9:20', '20:9', '1:2', '2:1', 'auto'] };
const flux = model({ references: 10, images: 1, sizes: ['768', '1K', '1.5K', '2K', '4K'],
  ratios: ['21:9', '2:1', '16:9', '3:2', '7:5', '4:3', '5:4', '1:1', '4:5', '3:4', '5:7', '2:3', '9:16', '1:2', '9:21', 'auto'] });
const reviewed = new Map<string, ImageModel>([
  ['openai/gpt-image-2.5-flare', openai], ['openai/gpt-image-2.5-sunburst', openai],
  ['x-ai/grok-imagine-image-2.0', model({ ...grokBase, qualities: ['low', 'medium'] })],
  ['x-ai/grok-imagine-image-quality', model(grokBase)],
  ['black-forest-labs/flux-3-image', flux], ['black-forest-labs/flux-3-image-klein', flux],
]);
export function openrouterImageModel(canonicalId: string): ImageModel | null {
  return reviewed.get(canonicalId) ?? (legacyIds.has(canonicalId) ? legacy : null);
}
