import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
const f = vi.hoisted(() => ({ job: null as any }));
vi.mock('../services/ai-router/authorize-app-call.js', () => ({ authorizeAppAiCall: async () => ({ ok: true, ownerId: 'owner', caller: { kind: 'owner' } }) }));
vi.mock('../services/region-resolver.js', () => ({ getRuntimeDbForApp: async () => ({}), resolveAppHomeRegion: async () => 'test' }));
vi.mock('../services/app-org-resolver.js', () => ({ resolveOrgFromApp: async () => 'org' }));
vi.mock('../services/ai-router/image-jobs.js', async importOriginal => ({
  ...await importOriginal<typeof import('../services/ai-router/image-jobs.js')>(),
  getImageJob: async () => f.job,
}));
import { aiImageRoutes } from './ai-images.js';
import { openrouterAdapter } from '../services/ai-router/adapters/openrouter.js';

let app: ReturnType<typeof Fastify> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe('multiple inline image outputs', () => {
  async function generation(data: Array<{ b64_json: string; media_type: string }>) {
    return openrouterAdapter({ apiKey: 'test', fetch: (async () => new Response(JSON.stringify({ data, usage: { cost: 0.2 } }))) as typeof fetch })
      .submitImage!({ model: 'openai/gpt-image-2.5-flare', prompt: 'Two variations', n: 2 }, 'openai/gpt-image-2.5-flare');
  }
  it('preserves every returned image in order alongside the full response cost', async () => {
    const result = await generation([{ b64_json: 'Zmlyc3Q=', media_type: 'image/png' }, { b64_json: 'c2Vjb25k', media_type: 'image/jpeg' }]);
    expect(result.unsignedUrls).toEqual(['data:image/png;base64,Zmlyc3Q=', 'data:image/jpeg;base64,c2Vjb25k']);
    expect(result.providerCostUsd).toBe(0.2);
  });
  it('publishes and serves each completed output with its own content type on repeated reads', async () => {
    const result = await generation([{ b64_json: 'Zmlyc3Q=', media_type: 'image/png' }, { b64_json: 'c2Vjb25k', media_type: 'image/jpeg' }]);
    f.job = { id: 'job', app_id: 'app', status: 'completed', model: 'openai/gpt-image-2.5-flare',
      unsigned_urls: result.unsignedUrls, content_type: result.contentType, charged_credits_usd: '0.22',
      settled_at: new Date(), created_at: new Date(), n: 2 };
    app = Fastify(); app.decorate('controlDb', {} as any); await app.register(aiImageRoutes);
    for (let read = 0; read < 2; read++) {
      const poll = await app.inject('/v1/app/images/completions/job');
      expect(poll.statusCode).toBe(200);
      expect(poll.json().content_urls).toHaveLength(2);
      expect(poll.json().charged_credits_usd).toBe(0.22);
    }
    const first = await app.inject('/v1/app/images/completions/job/content?index=0');
    const second = await app.inject('/v1/app/images/completions/job/content?index=1');
    expect(first.statusCode).toBe(200); expect(first.headers['content-type']).toBe('image/png'); expect(first.body).toBe('first');
    expect(second.statusCode).toBe(200); expect(second.headers['content-type']).toBe('image/jpeg'); expect(second.body).toBe('second');
  });
  it('accepts a provider returning fewer images than the requested upper bound', async () => {
    const result = await generation([{ b64_json: 'Zmlyc3Q=', media_type: 'image/png' }]);
    expect(result.status).toBe('completed'); expect(result.unsignedUrls).toHaveLength(1);
  });
});
