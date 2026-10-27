import { describe, expect, it, vi } from 'vitest';
import { openrouterAdapter } from './openrouter.js';

function adapter() {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'job', polling_url: 'https://upstream.example/job', status: 'pending' }), { status: 202 }));
  return { fetcher, adapter: openrouterAdapter({ apiKey: 'test', fetch: fetcher as typeof fetch }) };
}
const first = (url: string) => ({ type: 'image_url', image_url: { url }, frame_type: 'first_frame' });
const request = { model: 'minimax/hailuo-3', prompt: 'A scene' };

describe('OpenRouter effective video inputs', () => {
  it('derives native frames from canonical images without submitting duplicate canonical fields', async () => {
    const f = adapter(); await f.adapter.submitVideo!({ ...request, input_images: ['https://images.example/a'] }, request.model);
    const init = (f.fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0][1];
    const body = JSON.parse(String(init.body));
    expect(body.frame_images).toEqual([first('https://images.example/a')]);
    expect(body.input_images).toBeUndefined();
  });
  it('preserves an existing canonical mirror and independent style reference once each', async () => {
    const f = adapter(); await f.adapter.submitVideo!({ ...request, input_images: ['https://images.example/a'],
      frame_images: [first('https://images.example/a')], input_references: ['https://images.example/style'] }, request.model);
    const init = (f.fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0][1];
    const body = JSON.parse(String(init.body));
    expect(body.frame_images).toEqual([first('https://images.example/a')]);
    expect(body.input_references).toEqual([{ type: 'image_url', image_url: { url: 'https://images.example/style' } }]);
    expect(body.input_images).toBeUndefined();
  });
  it.each([
    { input_images: Array(7).fill('https://images.example/a') },
    { input_images: ['https://images.example/a'], frame_images: [first('https://images.example/different')] },
  ])('rejects ambiguous canonical images before paid submission: %j', async extras => {
    const f = adapter();
    await expect(f.adapter.submitVideo!({ ...request, ...extras }, request.model)).rejects.toMatchObject({ kind: 'bad_request', statusCode: 400 });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
