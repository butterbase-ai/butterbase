import { describe, it, expect, vi } from 'vitest';
import { routeMessages } from './messages.js';

vi.mock('./router.js', async (orig) => {
  const real = await orig<typeof import('./router.js')>();
  return { ...real, routeChatCompletion: vi.fn() };
});
const { routeChatCompletion } = await import('./router.js');

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
