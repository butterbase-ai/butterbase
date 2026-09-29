import { describe, it, expect } from 'vitest';
import { openrouterAdapter } from './openrouter.js';
import { AdapterError } from './types.js';

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

describe('openrouter adapter — decisions()', () => {
  const req = {
    model: 'typesafe/jev-1.13',
    state: { ticket: 'Checkout is blank after Pay' },
    questions: { is_bug: { type: 'noul', instructions: 'Is this a defect?', criteria: { true: 'broken', false: 'question' } } },
  };

  it('POSTs the body verbatim to /api/alpha/decisions and maps input/output tokens', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({
        id: 'gen-dec-1', model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe',
        answers: { is_bug: { type: 'noul', noul: 0.96 } },
        usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = openrouterAdapter({ apiKey: 'k', fetch: fetcher });
    const r = await a.decisions!(req, 'typesafe/jev-1.13');
    expect(calls[0].url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(calls[0].body).toEqual(req);
    expect(r.usage).toEqual({ promptTokens: 476, completionTokens: 70, totalCost: 0.000019992 });
    expect(r.providerCostUsd).toBeCloseTo(0.000019992, 12);
    expect((r.body as any).answers.is_bug.noul).toBe(0.96);
  });

  it('honours a configured decisionsUrl', async () => {
    let seen = '';
    const fetcher = (async (url: string) => { seen = url; return new Response(JSON.stringify({ answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 }); }) as unknown as typeof fetch;
    const a = openrouterAdapter({ apiKey: 'k', fetch: fetcher, decisionsUrl: 'https://example.test/alpha/decisions' });
    await a.decisions!(req, 'typesafe/jev-1.13');
    expect(seen).toBe('https://example.test/alpha/decisions');
  });

  it('returns providerCostUsd=null when usage.cost is absent', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ answers: {}, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 })) as unknown as typeof fetch;
    const r = await openrouterAdapter({ apiKey: 'k', fetch: fetcher }).decisions!(req, 'typesafe/jev-1.13');
    expect(r.providerCostUsd).toBeNull();
    expect(r.usage?.promptTokens).toBe(10);
  });

  it('upstream 400 throws AdapterError kind=bad_request carrying the upstream text', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ error: { message: 'questions.is_bug.criteria must have true and false' } }), { status: 400 })) as unknown as typeof fetch;
    const p = openrouterAdapter({ apiKey: 'k', fetch: fetcher }).decisions!(req, 'typesafe/jev-1.13');
    await expect(p).rejects.toBeInstanceOf(AdapterError);
    await expect(p).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(p).rejects.toThrow(/criteria must have/);
  });
});
