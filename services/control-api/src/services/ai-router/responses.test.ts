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
import { routeChatCompletion } from './router.js';
import { insertResponseRow } from './responses-store.js';

function makeCcStream(content: string) {
  const lines = [
    `data: {"id":"cc1","choices":[{"delta":{"role":"assistant","content":""}}]}\n\n`,
    `data: {"id":"cc1","choices":[{"delta":{"content":"${content}"}}]}\n\n`,
    `data: {"id":"cc1","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\n`,
    `data: [DONE]\n\n`,
  ].join('');
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(lines));
      c.close();
    },
  });
}

async function drainStream(s: ReadableStream<Uint8Array>) {
  const r = s.getReader();
  while (true) {
    const { done } = await r.read();
    if (done) break;
  }
}

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

  it('threads the namespace map from request translation into the response', async () => {
    vi.mocked(routeChatCompletion).mockResolvedValueOnce({
      status: 200,
      chosen: 'openrouter',
      body: {
        id: 'cc_x',
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'call_1', type: 'function',
              function: { name: 'mcp__butterbase__manage_app', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    } as any);

    const r = await routeResponses({ runtimePool: {} } as any, {
      model: 'openai/gpt-4o',
      input: 'hi',
      tools: [{
        type: 'namespace', name: 'mcp__butterbase',
        tools: [{ type: 'function', name: 'manage_app', parameters: {} }],
      }],
    } as any);

    // The model saw the flattened tool...
    const sent = vi.mocked(routeChatCompletion).mock.calls.at(-1)![1] as any;
    expect(sent.tools.map((t: any) => t.function.name)).toEqual(['mcp__butterbase__manage_app']);
    // ...and the client gets it back split into name + namespace.
    expect(r.status).toBe(200);
    expect((r.body as any).output[0]).toMatchObject({
      type: 'function_call', name: 'manage_app', namespace: 'mcp__butterbase',
    });
  });

  it('streaming branch: returns a stream and calls insertResponseRow after drain', async () => {
    const mockInsert = vi.mocked(insertResponseRow);
    mockInsert.mockClear();

    vi.mocked(routeChatCompletion).mockResolvedValueOnce({
      status: 200,
      chosen: 'openrouter',
      stream: makeCcStream('streamed'),
    } as any);

    const r = await routeResponses({ runtimePool: {} } as any, {
      model: 'openai/gpt-4o',
      input: 'hi',
      stream: true,
    } as any);

    expect(r.status).toBe(200);
    expect(r.stream).toBeDefined();
    expect(mockInsert).not.toHaveBeenCalled();

    await drainStream(r.stream!);
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it('streaming branch: threads the namespace map into the SSE translator', async () => {
    const ccLines = [
      'data: {"id":"cc1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"mcp__butterbase__manage_app","arguments":"{}"}}]}}]}\n\n',
      'data: {"id":"cc1","choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    vi.mocked(routeChatCompletion).mockResolvedValueOnce({
      status: 200,
      chosen: 'openrouter',
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(ccLines));
          c.close();
        },
      }),
    } as any);

    const r = await routeResponses({ runtimePool: {} } as any, {
      model: 'openai/gpt-4o',
      input: 'hi',
      stream: true,
      tools: [{
        type: 'namespace', name: 'mcp__butterbase',
        tools: [{ type: 'function', name: 'manage_app', parameters: {} }],
      }],
    } as any);

    const reader = r.stream!.getReader();
    const dec = new TextDecoder();
    let raw = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value);
    }
    expect(raw).toContain('"namespace":"mcp__butterbase"');
    expect(raw).toContain('"name":"manage_app"');
    expect(raw).not.toContain('"name":"mcp__butterbase__manage_app"');
  });
});
