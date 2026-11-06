import { describe, expect, it, vi } from 'vitest';
import { imageSubmitSchema, validateImageParams } from './ai-images.js';
import { openrouterAdapter } from '../services/ai-router/adapters/openrouter.js';
import type { ImageGenerationRequest } from '../services/ai-router/adapters/types.js';

const models = ['openai/gpt-image-2.5-flare', 'openai/gpt-image-2.5-sunburst',
  'x-ai/grok-imagine-image-2.0', 'x-ai/grok-imagine-image-quality',
  'black-forest-labs/flux-3-image', 'black-forest-labs/flux-3-image-klein'];
const response = { data: [{ b64_json: 'iVBORw0KGgo=' }], usage: { cost: 0.012 } };
function fixture() {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } }));
  const adapter = openrouterAdapter({ apiKey: 'test', fetch: fetcher as typeof fetch });
  return { adapter, fetcher, adapters: new Map([['openrouter' as const, adapter]]) };
}
function validate(model: string, extras: Record<string, unknown>) {
  return validateImageParams(imageSubmitSchema.parse({ model, prompt: 'Draw a landscape', ...extras }), fixture().adapters);
}

describe('new image model contracts', () => {
  it.each(models)('claims %s for generation and reference editing', model => {
    const spec = fixture().adapter.getSupportedImageParams!(model);
    expect(spec?.topLevel.has('input_images')).toBe(true);
    expect(spec?.topLevel.has('aspect_ratio')).toBe(true);
    expect(validate(model, { input_images: ['https://images.example/a.png'], n: 1, aspect_ratio: '16:9' })).toBeNull();
  });

  it.each(models)('serializes ordered references and aspect ratio for %s', async model => {
    const { adapter, fetcher } = fixture();
    await adapter.submitImage!({ model, prompt: 'Use both references', aspect_ratio: '16:9',
      input_images: ['https://images.example/a.png', 'https://images.example/b.png'] }, model);
    const [url, init] = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(url).toBe('https://openrouter.ai/api/v1/images');
    expect(JSON.parse(String(init.body))).toEqual({ model, prompt: 'Use both references', aspect_ratio: '16:9', input_references: [
      { type: 'image_url', image_url: { url: 'https://images.example/a.png' } },
      { type: 'image_url', image_url: { url: 'https://images.example/b.png' } },
    ] });
  });

  it('forwards only declared OpenAI rendering options from the provider bag', async () => {
    const { adapter, fetcher } = fixture(); const model = models[0];
    await adapter.submitImage!({ model, prompt: 'A logo', size: '1024x1024', n: 2,
      provider: { quality: 'xhigh', background: 'transparent', output_compression: 80 } }, model);
    const init = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0][1];
    expect(JSON.parse(String(init.body))).toEqual({ model, prompt: 'A logo', size: '1024x1024', n: 2,
      quality: 'xhigh', background: 'transparent', output_compression: 80 });
  });

  it.each([
    [models[0], { provider: { quality: 'ultra' } }, 'provider.quality'],
    [models[0], { size: '9999x1024' }, 'size'],
    [models[0], { size: '1024x1024', aspect_ratio: '16:9' }, 'aspect_ratio'],
    [models[0], { provider: { output_compression: 101 } }, 'provider.output_compression'],
    [models[2], { n: 2 }, 'n'],
    [models[2], { provider: { quality: 'high' } }, 'provider.quality'],
    [models[2], { size: '4K' }, 'size'],
    [models[2], { input_images: Array(4).fill('https://images.example/a.png') }, 'input_images'],
    [models[4], { seed: 42 }, 'seed'],
    [models[4], { aspect_ratio: '100:1' }, 'aspect_ratio'],
    [models[4], { size: 'auto' }, 'size'],
    [models[4], { n: 2 }, 'n'],
    [models[4], { input_images: Array(11).fill('https://images.example/a.png') }, 'input_images'],
    [models[4], { provider: { model: 'other/model' } }, 'provider.model'],
  ] as Array<[string, Record<string, unknown>, string]>)('rejects unsupported %s options %j before generation', (model, extras, param) => {
    expect(validate(model, extras)).toMatchObject({ code: 'UNSUPPORTED_PARAM', param });
  });

  it('rejects unsupported option values at the adapter boundary without upstream IO', async () => {
    const { adapter, fetcher } = fixture();
    await expect(adapter.submitImage!({ model: models[2], prompt: 'A scene', n: 2 } as ImageGenerationRequest, models[2]))
      .rejects.toMatchObject({ statusCode: 400, kind: 'bad_request' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
