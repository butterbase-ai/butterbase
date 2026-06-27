import { describe, it, expect, vi } from 'vitest';
import { routeMessages } from './messages.js';

vi.mock('./router.js', async (orig) => {
  const real = await orig<typeof import('./router.js')>();
  return { ...real, routeChatCompletion: vi.fn() };
});
const { routeChatCompletion } = await import('./router.js');

vi.mock('./catalog.js', () => ({ readCatalogEntry: vi.fn() }));
vi.mock('./select.js', () => ({ rankRoutersForModel: vi.fn() }));
const { readCatalogEntry } = await import('./catalog.js');
const { rankRoutersForModel } = await import('./select.js');

describe('routeMessages (non-streaming, translated)', () => {
  it('translates request, calls routeChatCompletion, translates response', async () => {
    (routeChatCompletion as any).mockResolvedValue({
      status: 200, chosen: 'openrouter',
      body: { id: 'cc_x', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 2, completion_tokens: 1 } },
    });
    const result = await routeMessages(
      { adapters: new Map([['openrouter', { name: 'openrouter', capabilities: { supportsNativeMessages: () => false } } as any]]) } as any,
      { model: 'anthropic/claude-3.5-sonnet', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      {},
    );
    expect(result.status).toBe(200);
    expect((result.body as any).type).toBe('message');
    expect((result.body as any).content[0]).toEqual({ type: 'text', text: 'hi' });
  });
});

describe('routeMessages (native passthrough)', () => {
  it('calls adapter.nativeMessages and forwards body', async () => {
    vi.mocked(readCatalogEntry).mockResolvedValue({
      canonicalId: 'anthropic/claude-opus-4.8',
      routers: [{ name: 'provider-secondary', upstreamId: 'anthropic.claude-opus-4-8' }],
    } as any);
    vi.mocked(rankRoutersForModel).mockReturnValue([{ name: 'provider-secondary', upstreamId: 'anthropic.claude-opus-4-8' }] as any);

    const native = vi.fn().mockResolvedValue({
      status: 200,
      body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'anthropic/claude-opus-4.8',
              content: [{ type: 'text', text: 'native hi' }], stop_reason: 'end_turn',
              usage: { input_tokens: 3, output_tokens: 2 } },
      usage: { promptTokens: 3, completionTokens: 2, totalCost: null },
      providerCostUsd: null,
    });
    const adapters = new Map<string, any>([
      ['provider-secondary', {
        name: 'provider-secondary',
        capabilities: { supportsNativeMessages: (id: string) => id.startsWith('anthropic/') },
        toUpstreamId: (id: string) => id, nativeMessages: native,
      }],
    ]);

    const result = await routeMessages(
      { adapters, redis: {} as any } as any,
      { model: 'anthropic/claude-opus-4.8', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      { anthropicVersion: '2023-06-01' },
    );
    expect(native).toHaveBeenCalled();
    expect(result.status).toBe(200);
    expect((result.body as any).content[0]).toEqual({ type: 'text', text: 'native hi' });
  });
});
