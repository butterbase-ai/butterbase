/**
 * Tests for the dashboard-agent loop (runAgentTurn).
 *
 * All external I/O is mocked:
 *   - fetch         → gateway SSE stream
 *   - store.ts      → appendMessage / listMessages
 *   - mcp-client.ts → callMcpTool
 *   - tool-catalog.ts → getToolCatalog
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type pg from 'pg';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any dynamic imports
// ---------------------------------------------------------------------------

vi.mock('../store.js', () => ({
  appendMessage: vi.fn(),
  listMessages: vi.fn(),
}));

vi.mock('../mcp-client.js', () => ({
  callMcpTool: vi.fn(),
}));

vi.mock('../tool-catalog.js', () => ({
  getToolCatalog: vi.fn().mockReturnValue([
    {
      name: 'manage_app',
      description: 'Manage app lifecycle',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string' } },
        required: ['action'],
        additionalProperties: true,
      },
    },
  ]),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import { runAgentTurn, type LoopEvent } from '../loop.js';

// ---------------------------------------------------------------------------
// Typed helpers to keep tests clean
// ---------------------------------------------------------------------------

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;

/** Collect all LoopEvents emitted by the generator. */
async function collect(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/**
 * Build an SSE ReadableStream from an array of OpenAI delta objects.
 * Appends [DONE] automatically.
 */
function makeSseStream(deltas: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines =
    deltas.map((d) => `data: ${JSON.stringify(d)}\n\n`).join('') +
    'data: [DONE]\n\n';
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

/**
 * Return a mock fetch Response that streams SSE deltas.
 */
function gatewayResponse(deltas: object[]) {
  return {
    ok: true,
    body: makeSseStream(deltas),
  } as unknown as Response;
}

/** Minimal stub pool — store calls are mocked so the actual pool is never used. */
const stubPool = {} as pg.Pool;

/** Stub return value for appendMessage */
const stubMessage = {
  id: 'msg-stub',
  conversationId: 'conv-1',
  role: 'user' as const,
  content: '',
  toolCallId: null,
  toolName: null,
  toolArgs: null,
  toolResult: null,
  createdAt: new Date(),
};

// ---------------------------------------------------------------------------
// Common input
// ---------------------------------------------------------------------------

const baseInput = {
  conversationId: 'conv-1',
  userId: 'user-1',
  jwt: 'test-jwt',
  userMessage: 'Hello',
  model: 'claude-3-5-sonnet',
  pool: stubPool,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendMessage.mockResolvedValue(stubMessage);
  mockListMessages.mockResolvedValue([]);
});

describe('runAgentTurn — no tool calls', () => {
  it('yields token events then assistant_message + done; persists user and assistant messages', async () => {
    // Gateway emits two content tokens then stops
    global.fetch = vi.fn().mockResolvedValueOnce(
      gatewayResponse([
        { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
        { choices: [{ delta: { content: ' world' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    );

    const events = await collect(runAgentTurn(baseInput));

    // Event sequence
    expect(events).toEqual([
      { type: 'token', text: 'Hello' },
      { type: 'token', text: ' world' },
      { type: 'assistant_message', content: 'Hello world' },
      { type: 'done' },
    ]);

    // User message persisted first
    expect(mockAppendMessage).toHaveBeenNthCalledWith(
      1,
      stubPool,
      'conv-1',
      expect.objectContaining({ role: 'user', content: 'Hello' }),
    );

    // Final assistant message persisted
    expect(mockAppendMessage).toHaveBeenNthCalledWith(
      2,
      stubPool,
      'conv-1',
      expect.objectContaining({ role: 'assistant', content: 'Hello world', toolCallId: null }),
    );

    // Exactly two appendMessage calls
    expect(mockAppendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('runAgentTurn — one tool call', () => {
  it('yields tool_call, tool_result, then tokens, assistant_message, done; persists 4 rows', async () => {
    // First gateway pass: emits a tool call for manage_app
    const firstPass = gatewayResponse([
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'manage_app', arguments: '' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"action":"list"}' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    // Second gateway pass: plain text response
    const secondPass = gatewayResponse([
      { choices: [{ delta: { content: 'You have no apps.' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);

    global.fetch = vi.fn()
      .mockResolvedValueOnce(firstPass)
      .mockResolvedValueOnce(secondPass);

    mockCallMcpTool.mockResolvedValueOnce({ ok: true, result: { apps: [] } });

    const events = await collect(runAgentTurn(baseInput));

    // Event sequence
    expect(events).toEqual([
      { type: 'tool_call', id: 'call-1', name: 'manage_app', args: { action: 'list' } },
      { type: 'tool_result', id: 'call-1', result: { apps: [] } },
      { type: 'token', text: 'You have no apps.' },
      { type: 'assistant_message', content: 'You have no apps.' },
      { type: 'done' },
    ]);

    // MCP called with flat args
    expect(mockCallMcpTool).toHaveBeenCalledWith('manage_app', { action: 'list' }, 'test-jwt');

    // 4 persisted rows: user, assistant+tool_call, tool_result, final assistant
    expect(mockAppendMessage).toHaveBeenCalledTimes(4);

    expect(mockAppendMessage).toHaveBeenNthCalledWith(
      1,
      stubPool,
      'conv-1',
      expect.objectContaining({ role: 'user', content: 'Hello' }),
    );
    expect(mockAppendMessage).toHaveBeenNthCalledWith(
      2,
      stubPool,
      'conv-1',
      expect.objectContaining({ role: 'assistant', toolCallId: 'call-1', toolName: 'manage_app' }),
    );
    expect(mockAppendMessage).toHaveBeenNthCalledWith(
      3,
      stubPool,
      'conv-1',
      expect.objectContaining({ role: 'tool', toolCallId: 'call-1', toolResult: { apps: [] } }),
    );
    expect(mockAppendMessage).toHaveBeenNthCalledWith(
      4,
      stubPool,
      'conv-1',
      expect.objectContaining({ role: 'assistant', content: 'You have no apps.', toolCallId: null }),
    );
  });
});

describe('runAgentTurn — tool cap', () => {
  it('emits at most 8 tool_call frames then an error frame', async () => {
    // Gateway always returns a tool_call
    const toolCallPass = () =>
      gatewayResponse([
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: `call-x`, function: { name: 'manage_app', arguments: '' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"action":"list"}' } }] },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]);

    // Return fresh streams for each fetch call (streams can only be consumed once)
    global.fetch = vi.fn().mockImplementation(() => Promise.resolve(toolCallPass()));

    // MCP always succeeds so loop can continue
    mockCallMcpTool.mockResolvedValue({ ok: true, result: {} });

    const events = await collect(runAgentTurn(baseInput));

    const toolCallEvents = events.filter((e) => e.type === 'tool_call');
    const errorEvents = events.filter((e) => e.type === 'error');

    expect(toolCallEvents.length).toBe(8);
    expect(errorEvents.length).toBe(1);
    expect((errorEvents[0] as { type: 'error'; message: string }).message).toMatch(/limit/i);

    // done should NOT be emitted — error is the terminal event
    expect(events.find((e) => e.type === 'done')).toBeUndefined();

    // Fix 3: assert persistence count.
    // 1 user row + 8 × (1 assistant row + 1 tool row) = 17 total calls.
    expect(mockAppendMessage).toHaveBeenCalledTimes(17);
  });
});

describe('runAgentTurn — MCP failure', () => {
  it('yields tool_result with error, feeds error back, continues to final assistant_message', async () => {
    // First gateway pass: tool call
    const firstPass = gatewayResponse([
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call-err', function: { name: 'manage_app', arguments: '' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"action":"list"}' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    // Second gateway pass: continues after receiving error result
    const secondPass = gatewayResponse([
      { choices: [{ delta: { content: 'Something went wrong.' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);

    global.fetch = vi.fn()
      .mockResolvedValueOnce(firstPass)
      .mockResolvedValueOnce(secondPass);

    // MCP returns an error
    mockCallMcpTool.mockResolvedValueOnce({ ok: false, error: 'boom' });

    const events = await collect(runAgentTurn(baseInput));

    // tool_result must carry the error
    const toolResultEvent = events.find((e) => e.type === 'tool_result') as
      | { type: 'tool_result'; id: string; error?: string }
      | undefined;
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent!.id).toBe('call-err');
    expect(toolResultEvent!.error).toBe('boom');

    // Loop continues and produces a final response
    const assistantEvent = events.find((e) => e.type === 'assistant_message') as
      | { type: 'assistant_message'; content: string }
      | undefined;
    expect(assistantEvent).toBeDefined();
    expect(assistantEvent!.content).toBe('Something went wrong.');

    expect(events.at(-1)).toEqual({ type: 'done' });

    // The error result was persisted to the store with error shape
    expect(mockAppendMessage).toHaveBeenCalledWith(
      stubPool,
      'conv-1',
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'call-err',
        toolResult: { error: 'boom' },
      }),
    );

    // The second gateway call received the error content in the messages
    const secondFetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const secondBody = JSON.parse(secondFetchCall[1].body as string) as {
      messages: Array<{ role: string; content?: string }>;
    };
    const toolMsg = secondBody.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(JSON.parse(toolMsg!.content ?? '{}')).toEqual({ error: 'boom' });
  });
});

describe('runAgentTurn — two tool calls in one pass (Fix 1)', () => {
  it('processes both tool calls, emits tool_call+tool_result pairs for each, sends correct OpenAI multi-call history', async () => {
    // First gateway pass: emits TWO tool_call fragments (distinct ids/indices)
    const firstPass = gatewayResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call-A', function: { name: 'manage_app', arguments: '' } },
                { index: 1, id: 'call-B', function: { name: 'manage_app', arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"action":"list"}' } },
                { index: 1, function: { arguments: '{"action":"get_config","id":"app_x"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    // Second gateway pass: plain text after receiving both results
    const secondPass = gatewayResponse([
      { choices: [{ delta: { content: 'Here are your apps and config.' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);

    global.fetch = vi.fn()
      .mockResolvedValueOnce(firstPass)
      .mockResolvedValueOnce(secondPass);

    // Return different results per call
    mockCallMcpTool
      .mockResolvedValueOnce({ ok: true, result: { apps: ['myapp'] } })   // call-A
      .mockResolvedValueOnce({ ok: true, result: { config: { plan: 'pro' } } }); // call-B

    const events = await collect(runAgentTurn(baseInput));

    // Expect two tool_call + two tool_result events before the final text
    expect(events[0]).toEqual({ type: 'tool_call', id: 'call-A', name: 'manage_app', args: { action: 'list' } });
    expect(events[1]).toEqual({ type: 'tool_result', id: 'call-A', result: { apps: ['myapp'] } });
    expect(events[2]).toEqual({ type: 'tool_call', id: 'call-B', name: 'manage_app', args: { action: 'get_config', id: 'app_x' } });
    expect(events[3]).toEqual({ type: 'tool_result', id: 'call-B', result: { config: { plan: 'pro' } } });
    expect(events[4]).toEqual({ type: 'token', text: 'Here are your apps and config.' });
    expect(events[5]).toEqual({ type: 'assistant_message', content: 'Here are your apps and config.' });
    expect(events[6]).toEqual({ type: 'done' });

    // Two MCP calls with the correct arguments
    expect(mockCallMcpTool).toHaveBeenCalledTimes(2);
    expect(mockCallMcpTool).toHaveBeenNthCalledWith(1, 'manage_app', { action: 'list' }, 'test-jwt');
    expect(mockCallMcpTool).toHaveBeenNthCalledWith(2, 'manage_app', { action: 'get_config', id: 'app_x' }, 'test-jwt');

    // Persistence: 1 user + 2 assistant (one per tool_call) + 2 tool + 1 final assistant = 6
    expect(mockAppendMessage).toHaveBeenCalledTimes(6);
    expect(mockAppendMessage).toHaveBeenNthCalledWith(
      2, stubPool, 'conv-1',
      expect.objectContaining({ role: 'assistant', toolCallId: 'call-A' }),
    );
    expect(mockAppendMessage).toHaveBeenNthCalledWith(
      3, stubPool, 'conv-1',
      expect.objectContaining({ role: 'tool', toolCallId: 'call-A', toolResult: { apps: ['myapp'] } }),
    );
    expect(mockAppendMessage).toHaveBeenNthCalledWith(
      4, stubPool, 'conv-1',
      expect.objectContaining({ role: 'assistant', toolCallId: 'call-B' }),
    );
    expect(mockAppendMessage).toHaveBeenNthCalledWith(
      5, stubPool, 'conv-1',
      expect.objectContaining({ role: 'tool', toolCallId: 'call-B', toolResult: { config: { plan: 'pro' } } }),
    );

    // OpenAI multi-call order: second fetch body must have one assistant message
    // with tool_calls array, followed by two tool messages in order.
    const secondFetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const secondBody = JSON.parse(secondFetchCall[1].body as string) as {
      messages: Array<{ role: string; tool_calls?: unknown[]; tool_call_id?: string }>;
    };
    const assistantMsg = secondBody.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    expect(assistantMsg).toBeDefined();
    expect((assistantMsg!.tool_calls as unknown[]).length).toBe(2);

    const toolMsgs = secondBody.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs[0].tool_call_id).toBe('call-A');
    expect(toolMsgs[1].tool_call_id).toBe('call-B');
  });
});

describe('runAgentTurn — gateway HTTP error (Fix 2)', () => {
  it('yields a single error event with status info, no done event, no throw', async () => {
    // Mock fetch to return a non-2xx response — streamChatCompletion throws "gateway 500"
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      body: null,
    } as unknown as Response);

    const events = await collect(runAgentTurn(baseInput));

    // Exactly one error event, message mentions status
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(1);
    expect((errorEvents[0] as { type: 'error'; message: string }).message).toMatch(/500/);

    // No 'done' event
    expect(events.find((e) => e.type === 'done')).toBeUndefined();

    // Generator terminates cleanly (collect() would have thrown if it escaped)
  });
});
