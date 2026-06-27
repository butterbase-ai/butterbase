import { describe, it, expect, vi } from 'vitest';

vi.mock('./router.js', async (o) => {
  const real = await o<typeof import('./router.js')>();
  return {
    ...real,
    routeChatCompletion: vi.fn().mockResolvedValue({
      status: 200,
      chosen: 'openrouter',
      body: {
        id: 'cc_x',
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    }),
  };
});
vi.mock('./responses-store.js', () => ({
  loadResponseRow: vi.fn().mockResolvedValue(null),
  insertResponseRow: vi.fn().mockResolvedValue(undefined),
  generateResponseId: () => 'rsp_test12345',
  DEFAULT_TTL_SECONDS: 2_592_000,
}));

import { routeResponses } from './responses.js';

describe('routeResponses', () => {
  it('rejects built-in tools with 400 unsupported_tool', async () => {
    const r = await routeResponses({ runtimePool: {} } as any, {
      model: 'openai/gpt-4o',
      input: 'hi',
      tools: [{ type: 'web_search_preview' } as any],
    } as any);
    expect(r.status).toBe(400);
    expect((r.body as any).error.code).toBe('unsupported_tool');
  });

  it('returns Responses-shaped body and persists row', async () => {
    const r = await routeResponses({ runtimePool: {} } as any, {
      model: 'openai/gpt-4o',
      input: 'hi',
    } as any);
    expect(r.status).toBe(200);
    expect((r.body as any).id).toBe('rsp_test12345');
    expect((r.body as any).output[0].content[0].text).toBe('hi');
  });
});
