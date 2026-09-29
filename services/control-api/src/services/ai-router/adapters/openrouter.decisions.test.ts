import { describe, it, expect } from 'vitest';
import { openrouterAdapter } from './openrouter.js';

/** Query-aware fetcher: keys are path+query suffixes, e.g. '/models?output_modalities=decisions'. */
function queryFetcher(routes: Record<string, unknown | { __status: number; body?: unknown }>): typeof fetch {
  const entries = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    for (const [needle, payload] of entries) {
      if (!u.endsWith(needle)) continue;
      if (payload && typeof payload === 'object' && '__status' in (payload as any)) {
        const p = payload as { __status: number; body?: unknown };
        return new Response(JSON.stringify(p.body ?? {}), { status: p.__status });
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const JEV_ROW = {
  id: 'typesafe/jev-1.13',
  name: 'TypeSafe: Jev 1.13',
  pricing: { prompt: '0.000000042', completion: '0' },
  context_length: 32000,
  architecture: { input_modalities: ['text'], output_modalities: ['decisions'] },
};

describe('openrouter adapter — decisions catalog', () => {
  it('pulls /models?output_modalities=decisions and tags rows modality=decisions', async () => {
    const a = openrouterAdapter({
      apiKey: 'k',
      fetch: queryFetcher({
        '/models': { data: [] },
        '/models?output_modalities=image': { data: [] },
        '/models?output_modalities=decisions': { data: [JEV_ROW] },
        '/videos/models': { data: [] },
      }),
    });
    const models = await a.listModels();
    const jev = models.find(m => m.upstreamId === 'typesafe/jev-1.13');
    expect(jev).toBeDefined();
    expect(jev!.modality).toBe('decisions');
    expect(jev!.promptPricePerMtok).toBeCloseTo(0.042, 6);
    expect(jev!.completionPricePerMtok).toBe(0);
    expect(jev!.rawPricing).toBeUndefined();
  });

  it('does not fail the catalog when the decisions fetch errors', async () => {
    const a = openrouterAdapter({
      apiKey: 'k',
      fetch: queryFetcher({
        '/models': { data: [{ id: 'openai/gpt-4o-mini', name: 'mini', pricing: { prompt: '0.00000015', completion: '0.0000006' }, context_length: 128000 }] },
        '/models?output_modalities=image': { data: [] },
        '/models?output_modalities=decisions': { __status: 500 },
        '/videos/models': { data: [] },
      }),
    });
    const models = await a.listModels();
    expect(models.map(m => m.upstreamId)).toContain('openai/gpt-4o-mini');
  });

  it('clamps OpenRouter "-1" variable-price sentinels to 0', async () => {
    const a = openrouterAdapter({
      apiKey: 'k',
      fetch: queryFetcher({
        '/models': { data: [{ id: 'typesafe/jev-router', name: 'Jev Router', pricing: { prompt: '-1', completion: '-1' }, context_length: 1000000, architecture: { output_modalities: ['text'] } }] },
        '/models?output_modalities=image': { data: [] },
        '/models?output_modalities=decisions': { data: [] },
        '/videos/models': { data: [] },
      }),
    });
    const [router] = await a.listModels();
    expect(router.promptPricePerMtok).toBe(0);
    expect(router.completionPricePerMtok).toBe(0);
  });

});
