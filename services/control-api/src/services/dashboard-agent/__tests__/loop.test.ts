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
  getRecentToolArgs: vi.fn(),
  upsertSnapshotLabel: vi.fn(),
  getConversation: vi.fn(),
  updateConversationTitle: vi.fn(),
}));

vi.mock('../mcp-client.js', () => ({
  callMcpTool: vi.fn(),
}));

vi.mock('../approvals-store.js', () => ({
  createApproval: vi.fn(),
  checkTrust: vi.fn(),
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
    {
      name: 'write_file',
      description: 'write file',
      parameters: { type: 'object', additionalProperties: true, required: ['app_id', 'path', 'content'] },
    },
    {
      name: 'read_file',
      description: 'read file',
      parameters: { type: 'object', additionalProperties: true, required: ['app_id', 'path'] },
    },
    {
      name: 'list_files',
      description: 'list files',
      parameters: { type: 'object', additionalProperties: true, required: ['app_id'] },
    },
    {
      name: 'delete_file',
      description: 'delete file',
      parameters: { type: 'object', additionalProperties: true, required: ['app_id', 'path'] },
    },
    {
      name: 'deploy_frontend',
      description: 'deploy',
      parameters: { type: 'object', additionalProperties: true, required: ['app_id'] },
    },
    {
      name: 'deploy_function_from_workspace',
      description: 'deploy function',
      parameters: { type: 'object', additionalProperties: true, required: ['app_id', 'function_name'] },
    },
  ]),
  isFileOpTool: (name: string) =>
    name === 'write_file' || name === 'read_file' || name === 'list_files' || name === 'delete_file',
  isDeployTool: (name: string) => name === 'deploy_frontend',
  isDeployFunctionTool: (name: string) => name === 'deploy_function_from_workspace',
  sensitivityFor: (name: string, args: any) => {
    const action = args && typeof args === 'object' ? (args as Record<string, unknown>).action : null;
    if (name === 'manage_app' && (action === 'delete' || action === 'pause')) return 'destructive';
    if (name === 'manage_repo' && action === 'wipe') return 'destructive';
    if (name === 'manage_billing') return 'destructive';
    if (name === 'manage_migrations' && (action === 'abort' || action === 'reverse')) return 'destructive';
    return 'safe';
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import * as approvalsStoreModule from '../approvals-store.js';
import { runAgentTurn, type LoopEvent } from '../loop.js';

// ---------------------------------------------------------------------------
// Typed helpers to keep tests clean
// ---------------------------------------------------------------------------

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockUpsertSnapshotLabel = storeModule.upsertSnapshotLabel as MockedFunction<typeof storeModule.upsertSnapshotLabel>;
const mockGetConversation = storeModule.getConversation as MockedFunction<typeof storeModule.getConversation>;
const mockUpdateConversationTitle = storeModule.updateConversationTitle as MockedFunction<typeof storeModule.updateConversationTitle>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;
const mockCreateApproval = approvalsStoreModule.createApproval as MockedFunction<typeof approvalsStoreModule.createApproval>;
const mockCheckTrust = approvalsStoreModule.checkTrust as MockedFunction<typeof approvalsStoreModule.checkTrust>;

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
  modelUsed: null,
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
  mockGetRecentToolArgs.mockResolvedValue([]);
  mockUpsertSnapshotLabel.mockResolvedValue(undefined);
  // Default: no conversation found → auto-titling is a no-op for tests that
  // don't care about it. Tests exercising Task 2 override this.
  mockGetConversation.mockResolvedValue(null);
  mockUpdateConversationTitle.mockResolvedValue(null);
  // Default: no sensitivity gate involvement for existing tests that never
  // touch a confirm/destructive tool. Tests exercising the gate override this.
  mockCheckTrust.mockResolvedValue(true);
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
      expect.objectContaining({
        role: 'assistant',
        content: 'Hello world',
        toolCallId: null,
        modelUsed: baseInput.model,
      }),
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
      expect.objectContaining({
        role: 'assistant',
        toolCallId: 'call-1',
        toolName: 'manage_app',
        modelUsed: baseInput.model,
      }),
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
      expect.objectContaining({
        role: 'assistant',
        content: 'You have no apps.',
        toolCallId: null,
        modelUsed: baseInput.model,
      }),
    );

    // Tool-role rows must NOT carry modelUsed.
    expect(mockAppendMessage).toHaveBeenNthCalledWith(
      3,
      stubPool,
      'conv-1',
      expect.not.objectContaining({ modelUsed: expect.anything() }),
    );
  });
});

describe('runAgentTurn — tool cap', () => {
  it('emits at most 8 tool_call frames then an error frame', async () => {
    // Gateway always returns a tool_call. Args vary per call (distinct `id` arg)
    // so the Task 5 retry-budget guard never trips — this test exercises the
    // tool-call cap in isolation.
    let callIndex = 0;
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
              delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ action: 'list', id: `iter-${callIndex++}` }) } }] },
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

describe('runAgentTurn — tool retry budget (Task 5)', () => {
  it('stops after 3 invocations when the same tool is called with identical args repeatedly, emits a stuck error frame, and persists an assistant summary', async () => {
    // Gateway scripts the SAME tool call with the SAME args four times in a row.
    const sameCallPass = () =>
      gatewayResponse([
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: 'call-retry', function: { name: 'manage_app', arguments: '' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"action":"list","id":"app_1"}' } }] },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]);

    // Fresh streams per fetch call (each pass would only be reached if the loop
    // kept going — the retry guard should stop it before a 4th fetch happens).
    global.fetch = vi.fn().mockImplementation(() => Promise.resolve(sameCallPass()));

    mockCallMcpTool.mockResolvedValue({ ok: true, result: {} });

    const events = await collect(runAgentTurn(baseInput));

    // Only 3 tool invocations should have happened (the 4th is caught by the guard
    // before dispatch).
    expect(mockCallMcpTool).toHaveBeenCalledTimes(3);

    const errorEvents = events.filter((e) => e.type === 'error') as Array<{ type: 'error'; message: string }>;
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0].message).toMatch(/stuck on manage_app/);
    expect(errorEvents[0].message).toMatch(/same args tried 3 times/);

    // done should NOT be emitted — the stuck error is terminal.
    expect(events.find((e) => e.type === 'done')).toBeUndefined();

    // An assistant summary message describing the stuck state must be persisted.
    const assistantSummaryCalls = mockAppendMessage.mock.calls.filter(
      ([, , msg]) =>
        (msg as { role: string; toolCallId: unknown; modelUsed?: unknown }).role === 'assistant' &&
        (msg as { toolCallId: unknown }).toolCallId === null,
    );
    // First is the initial "no tool call yet" style row never happens here since every
    // pass has a tool call; the persisted stuck-summary row is the one we care about.
    const stuckSummaryCall = mockAppendMessage.mock.calls.find(
      ([, , msg]) =>
        (msg as { role: string; content?: string }).role === 'assistant' &&
        typeof (msg as { content?: string }).content === 'string' &&
        (msg as { content?: string }).content!.includes('manage_app'),
    );
    expect(stuckSummaryCall).toBeDefined();
    expect((stuckSummaryCall![2] as { modelUsed?: string }).modelUsed).toBe(baseInput.model);

    // The stuck-state summary should also be emitted as an assistant_message event.
    const assistantMessageEvent = events.find((e) => e.type === 'assistant_message') as
      | { type: 'assistant_message'; content: string }
      | undefined;
    expect(assistantMessageEvent).toBeDefined();
    expect(assistantMessageEvent!.content).toContain('manage_app');
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

describe('runAgentTurn — tool not in catalog (I-1 allowlist guard)', () => {
  it('yields tool_call + tool_result(error) without calling MCP; second pass produces final assistant_message + done', async () => {
    // First pass: model tries to call manage_organizations (NOT in catalog)
    const firstPass = gatewayResponse([
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call-blocked', function: { name: 'manage_organizations', arguments: '' } }] },
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

    // Second pass: model adapts and returns plain text
    const secondPass = gatewayResponse([
      { choices: [{ delta: { content: 'I cannot do that.' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);

    global.fetch = vi.fn()
      .mockResolvedValueOnce(firstPass)
      .mockResolvedValueOnce(secondPass);

    const events = await collect(runAgentTurn(baseInput));

    // First event: tool_call emitted for visibility
    expect(events[0]).toEqual({ type: 'tool_call', id: 'call-blocked', name: 'manage_organizations', args: { action: 'list' } });

    // Second event: tool_result with allowlist error
    expect(events[1]).toMatchObject({ type: 'tool_result', id: 'call-blocked' });
    expect((events[1] as { type: 'tool_result'; error?: string }).error).toMatch(/not available/);

    // MCP was NEVER invoked
    expect(mockCallMcpTool).not.toHaveBeenCalled();

    // Second pass produces clean termination
    expect(events.at(-2)).toEqual({ type: 'assistant_message', content: 'I cannot do that.' });
    expect(events.at(-1)).toEqual({ type: 'done' });
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

describe('runAgentTurn — insufficient credits (gateway 402)', () => {
  // The gateway's real 402 body (see billing-gate.ts insufficientCreditsFields
  // and gateway.ts handleRouterError): `balance_usd` / `credit_floor_usd` are
  // current, `available_usd` is a DEPRECATED ALIAS for `balance_usd` kept for
  // one release, and `required_usd` no longer exists — admission is "balance
  // below the org's credit floor," not a padded cost estimate.
  it('reads balance_usd (the current field) when present', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: async () => ({
        error: {
          code: 'insufficient_credits',
          type: 'billing_error',
          balance_usd: 0.5,
          credit_floor_usd: 1,
          available_usd: 0.5, // deprecated alias, still emitted alongside balance_usd
        },
      }),
    } as unknown as Response);

    const events = await collect(runAgentTurn(baseInput));
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({
      type: 'error',
      code: 'insufficient_credits',
      availableUsd: 0.5,
    });
    // required_usd has no honest equivalent post-credit-floor and must never
    // be fabricated — it should not appear on the emitted event.
    expect((err as { requiredUsd?: number }).requiredUsd).toBeUndefined();
  });

  it('falls back to the deprecated available_usd alias when balance_usd is absent', async () => {
    // Guards a mid-rollout gateway that hasn't picked up balance_usd yet.
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: async () => ({
        error: { code: 'insufficient_credits', type: 'billing_error', available_usd: 0.5 },
      }),
    } as unknown as Response);

    const events = await collect(runAgentTurn(baseInput));
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({
      type: 'error',
      code: 'insufficient_credits',
      availableUsd: 0.5,
    });
  });
});

// ---------------------------------------------------------------------------
// Task 7: builder-mode integration tests
// ---------------------------------------------------------------------------

import { WorkingTreeCache } from '../working-tree.js';
import { createFileOps } from '../file-ops.js';
import { createDeployer } from '../deploy.js';
import { createFunctionDeployer } from '../deploy-function.js';

/** Emit a single-tool-call gateway pass. */
function toolCallPass(id: string, name: string, argsJson: string) {
  return gatewayResponse([
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: argsJson } }] },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
}

/** Emit a plain-text gateway pass with an optional final usage frame. */
function textPass(text: string, usage?: { prompt_tokens: number; completion_tokens: number }) {
  const deltas: object[] = [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];
  if (usage) deltas.push({ choices: [], usage });
  return gatewayResponse(deltas);
}

describe('runAgentTurn — Task 7 file-op integration', () => {
  it('routes write_file to fileOps (not MCP) and emits file_change', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(toolCallPass('call-w', 'write_file', '{"app_id":"app_1","path":"src/App.tsx","content":"export default () => <div/>"}'))
      .mockResolvedValueOnce(textPass('done'));

    const cache = new WorkingTreeCache();
    const repoSync = {
      pullLatest: vi.fn().mockResolvedValue({ hydrated: true }),
      flush: vi.fn().mockResolvedValue({ pushed: 1, deleted: 0 }),
    };
    const recordUsageSpy = vi.fn().mockResolvedValue(undefined);
    const loadTemplateSpy = vi.fn().mockResolvedValue([]);

    const events = await collect(
      runAgentTurn(baseInput, {
        cache,
        repoSync: repoSync as any,
        recordUsage: recordUsageSpy,
        loadTemplate: loadTemplateSpy,
      }),
    );

    const fileChange = events.find((e) => e.type === 'file_change') as any;
    expect(fileChange).toBeDefined();
    expect(fileChange.app_id).toBe('app_1');
    expect(fileChange.path).toBe('src/App.tsx');
    expect(fileChange.kind).toBe('write');

    // MCP was NOT hit for write_file
    expect(mockCallMcpTool).not.toHaveBeenCalled();
    // Cache was populated
    expect(cache.read('conv-1', 'app_1', 'src/App.tsx')).toContain('export default');
  });

  it('scaffolds from template on first write_file against an empty app', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(toolCallPass('call-w', 'write_file', '{"app_id":"app_new","path":"src/App.tsx","content":"hello"}'))
      .mockResolvedValueOnce(textPass('done'));

    const cache = new WorkingTreeCache();
    const repoSync = {
      pullLatest: vi.fn().mockResolvedValue({ hydrated: false }),
      flush: vi.fn().mockResolvedValue({ pushed: 1, deleted: 0 }),
    };
    const loadTemplateSpy = vi.fn().mockResolvedValue([
      { path: 'package.json', content: '{}' },
      { path: 'src/main.tsx', content: 'import App from "./App"' },
      { path: 'src/lib/butterbase.ts', content: 'export const client = {}' },
    ]);

    await collect(
      runAgentTurn(baseInput, {
        cache,
        repoSync: repoSync as any,
        recordUsage: vi.fn().mockResolvedValue(undefined),
        loadTemplate: loadTemplateSpy,
      }),
    );

    expect(loadTemplateSpy).toHaveBeenCalledTimes(1);
    expect(cache.read('conv-1', 'app_new', 'src/main.tsx')).toContain('import App');
    expect(cache.read('conv-1', 'app_new', 'src/lib/butterbase.ts')).toContain('client');
    // The user's own write also landed
    expect(cache.read('conv-1', 'app_new', 'src/App.tsx')).toBe('hello');
  });

  it('flushes repoSync for every touched app at end of turn', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(toolCallPass('call-w', 'write_file', '{"app_id":"app_A","path":"a.tsx","content":"a"}'))
      .mockResolvedValueOnce(toolCallPass('call-x', 'write_file', '{"app_id":"app_B","path":"b.tsx","content":"b"}'))
      .mockResolvedValueOnce(textPass('done'));

    const cache = new WorkingTreeCache();
    const flushSpy = vi.fn().mockResolvedValue({ pushed: 1, deleted: 0 });
    const repoSync = {
      pullLatest: vi.fn().mockResolvedValue({ hydrated: true }),
      flush: flushSpy,
    };

    await collect(
      runAgentTurn(baseInput, {
        cache,
        repoSync: repoSync as any,
        recordUsage: vi.fn().mockResolvedValue(undefined),
        loadTemplate: vi.fn().mockResolvedValue([]),
      }),
    );

    expect(flushSpy).toHaveBeenCalledTimes(2);
    const appIds = flushSpy.mock.calls.map((c) => c[0].appId).sort();
    expect(appIds).toEqual(['app_A', 'app_B']);
  });

  it('routes deploy_frontend to deployer and emits deployment_progress', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(toolCallPass('call-d', 'deploy_frontend', '{"app_id":"app_1"}'))
      .mockResolvedValueOnce(textPass('shipped'));

    const cache = new WorkingTreeCache();
    // Pre-seed the cache so ensureHydrated is a no-op and deployer has files.
    cache.write('conv-1', 'app_1', 'index.html', '<html/>');

    const deploySpy = vi.fn(async (_input: { convId: string; appId: string; jwt: string }) => {
      // Trigger the emitter to prove routing.
      return { ok: true as const, deployment_id: 'dep_123', url: 'https://x.butterbase.dev' };
    });
    const deployerFactory = (emit: (evt: LoopEvent) => void) => ({
      deploy: (async (input: { convId: string; appId: string; jwt: string }) => {
        emit({ type: 'deployment_progress', deployment_id: 'dep_123', status: 'queued' });
        emit({ type: 'deployment_progress', deployment_id: 'dep_123', status: 'live', url: 'https://x.butterbase.dev' });
        return deploySpy(input);
      }) as any,
    });

    const events = await collect(
      runAgentTurn(baseInput, {
        cache,
        repoSync: {
          pullLatest: vi.fn().mockResolvedValue({ hydrated: true }),
          flush: vi.fn().mockResolvedValue({ pushed: 0, deleted: 0 }),
        } as any,
        recordUsage: vi.fn().mockResolvedValue(undefined),
        loadTemplate: vi.fn().mockResolvedValue([]),
        deployerFactory: deployerFactory as any,
      }),
    );

    const progressEvents = events.filter((e) => e.type === 'deployment_progress') as any[];
    expect(progressEvents.length).toBe(2);
    expect(progressEvents[0].status).toBe('queued');
    expect(progressEvents[1].status).toBe('live');
    expect(progressEvents[1].url).toBe('https://x.butterbase.dev');
    // Deployer was invoked, MCP was NOT hit.
    expect(deploySpy).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app_1' }));
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it('routes deploy_function_from_workspace to the function deployer and emits function_deployment_progress', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(toolCallPass('call-f', 'deploy_function_from_workspace', '{"app_id":"app_1","function_name":"hello"}'))
      .mockResolvedValueOnce(textPass('shipped'));

    const cache = new WorkingTreeCache();
    // Pre-seed the entry file so ensureHydrated is a no-op and the deployer has code.
    cache.write('conv-1', 'app_1', 'functions/hello/index.ts', 'export function handler() {}');

    const deploySpy = vi.fn(async (_input: any) => ({ ok: true as const, url: 'https://x.butterbase.dev/v1/app_1/fn/hello', deploymentId: 'fn_123' }));
    const functionDeployerFactory = (emit: (evt: LoopEvent) => void) => ({
      deploy: (async (input: any) => {
        emit({ type: 'function_deployment_progress', function_name: 'hello', status: 'queued' });
        emit({ type: 'function_deployment_progress', function_name: 'hello', status: 'uploading' });
        emit({ type: 'function_deployment_progress', function_name: 'hello', status: 'live', url: 'https://x.butterbase.dev/v1/app_1/fn/hello' });
        return deploySpy(input);
      }) as any,
    });

    const events = await collect(
      runAgentTurn(baseInput, {
        cache,
        repoSync: {
          pullLatest: vi.fn().mockResolvedValue({ hydrated: true }),
          flush: vi.fn().mockResolvedValue({ pushed: 0, deleted: 0 }),
        } as any,
        recordUsage: vi.fn().mockResolvedValue(undefined),
        loadTemplate: vi.fn().mockResolvedValue([]),
        functionDeployerFactory: functionDeployerFactory as any,
      }),
    );

    const progressEvents = events.filter((e) => e.type === 'function_deployment_progress') as any[];
    expect(progressEvents.map((e) => e.status)).toEqual(['queued', 'uploading', 'live']);
    expect(progressEvents[2].url).toBe('https://x.butterbase.dev/v1/app_1/fn/hello');

    expect(deploySpy).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app_1', functionName: 'hello' }),
    );
    // Deployer was invoked, MCP was NOT hit directly by the loop.
    expect(mockCallMcpTool).not.toHaveBeenCalled();

    const toolResult = events.find((e) => e.type === 'tool_result' && (e as any).id === 'call-f') as any;
    expect(toolResult.result).toMatchObject({ url: 'https://x.butterbase.dev/v1/app_1/fn/hello', deployment_id: 'fn_123' });
  });

  it('records usage with correct per-turn counters', async () => {
    global.fetch = vi.fn()
      // pass 1: write_file
      .mockResolvedValueOnce(toolCallPass('call-w', 'write_file', '{"app_id":"app_1","path":"a.tsx","content":"a"}'))
      // pass 2: deploy_frontend
      .mockResolvedValueOnce(toolCallPass('call-d', 'deploy_frontend', '{"app_id":"app_1"}'))
      // pass 3: text w/ usage
      .mockResolvedValueOnce(textPass('done', { prompt_tokens: 42, completion_tokens: 7 }));

    const cache = new WorkingTreeCache();
    const recordUsageSpy = vi.fn().mockResolvedValue(undefined);

    const deployerFactory = (_emit: (evt: LoopEvent) => void) => ({
      deploy: (async () => ({ ok: true as const, deployment_id: 'd1', url: 'https://y' })) as any,
    });

    await collect(
      runAgentTurn(baseInput, {
        cache,
        repoSync: {
          pullLatest: vi.fn().mockResolvedValue({ hydrated: true }),
          flush: vi.fn().mockResolvedValue({ pushed: 1, deleted: 0 }),
        } as any,
        recordUsage: recordUsageSpy,
        loadTemplate: vi.fn().mockResolvedValue([]),
        deployerFactory: deployerFactory as any,
      }),
    );

    expect(recordUsageSpy).toHaveBeenCalledTimes(1);
    const row = recordUsageSpy.mock.calls[0][1];
    expect(row).toMatchObject({
      userId: 'user-1',
      conversationId: 'conv-1',
      model: 'claude-3-5-sonnet',
      promptTokens: 42,
      completionTokens: 7,
      toolCallsCount: 2,
      fileWritesCount: 1,
      deploymentsCount: 1,
    });
  });

  it('injects live schema for recently-touched apps into the system prompt (Task 4)', async () => {
    // Recent tool_args show the conversation already touched app_1 via a prior tool call.
    mockGetRecentToolArgs.mockResolvedValueOnce([
      { action: 'get_config', app_id: 'app_1' },
    ]);

    global.fetch = vi.fn().mockResolvedValueOnce(textPass('done'));

    const mcpSpy = {
      call: vi.fn().mockResolvedValue({
        schema: {
          tables: {
            todos: {
              columns: {
                id: { type: 'uuid', primaryKey: true },
                title: { type: 'text', nullable: false },
              },
            },
          },
        },
      }),
    };

    await collect(
      runAgentTurn(baseInput, {
        mcp: mcpSpy as any,
        recordUsage: vi.fn().mockResolvedValue(undefined),
        loadTemplate: vi.fn().mockResolvedValue([]),
      }),
    );

    expect(mcpSpy.call).toHaveBeenCalledWith('manage_schema', { action: 'get', app_id: 'app_1' }, 'test-jwt');

    // The system prompt sent to the gateway must contain the compact schema block.
    const firstFetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(firstFetchCall[1].body as string) as {
      messages: Array<{ role: string; content?: string }>;
    };
    const systemMsg = body.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('# Current app schemas');
    expect(systemMsg!.content).toContain('app_1: todos(id uuid pk, title text NOT NULL)');
  });

  it('runs end-of-turn flush + recordUsage even when a tool invocation throws', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(toolCallPass('call-w', 'write_file', '{"app_id":"app_1","path":"src/App.tsx","content":"code"}'))
      .mockResolvedValueOnce(textPass('done'));

    const cache = new WorkingTreeCache();
    const flushSpy = vi.fn(async () => ({ pushed: 0, deleted: 0 }));
    const recordUsageSpy = vi.fn(async () => {});

    const throwingFileOps = {
      execute: vi.fn(async () => { throw new Error('fileOps error'); }),
    };

    const repoSync = {
      pullLatest: vi.fn().mockResolvedValue({ hydrated: true }),
      flush: flushSpy,
    };

    const events = await collect(
      runAgentTurn(baseInput, {
        cache,
        repoSync: repoSync as any,
        recordUsage: recordUsageSpy,
        loadTemplate: vi.fn().mockResolvedValue([]),
        fileOpsFactory: () => throwingFileOps as any,
      }),
    );

    // Even though fileOps.execute threw, end-of-turn must have run
    expect(flushSpy).toHaveBeenCalled();
    expect(recordUsageSpy).toHaveBeenCalled();

    // Should have an error event for the thrown exception
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { type: 'error'; message: string }).message).toContain('fileOps error');
  });
});

// ---------------------------------------------------------------------------
// Plan 3d Task 5: snapshot auto-naming
// ---------------------------------------------------------------------------

describe('runAgentTurn — snapshot auto-naming (Plan 3d Task 5)', () => {
  it('upserts a snapshot label with the verbatim user message when flush returns a newSnapshotId', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(toolCallPass('call-w', 'write_file', '{"app_id":"app_1","path":"src/App.tsx","content":"code"}'))
      .mockResolvedValueOnce(textPass('done'));

    const cache = new WorkingTreeCache();
    const flushSpy = vi.fn().mockResolvedValue({ pushed: 1, deleted: 0, newSnapshotId: 'snap-123' });
    const repoSync = {
      pullLatest: vi.fn().mockResolvedValue({ hydrated: true }),
      flush: flushSpy,
    };

    const gatewayChatSpy = vi.fn();
    const snapshotTitleGatewayFactory = vi.fn().mockReturnValue({ chat: gatewayChatSpy });

    await collect(
      runAgentTurn(
        { ...baseInput, userMessage: 'Add a button' },
        {
          cache,
          repoSync: repoSync as any,
          recordUsage: vi.fn().mockResolvedValue(undefined),
          loadTemplate: vi.fn().mockResolvedValue([]),
          snapshotTitleGatewayFactory,
        },
      ),
    );

    expect(flushSpy).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app_1' }));
    expect(mockUpsertSnapshotLabel).toHaveBeenCalledTimes(1);
    expect(mockUpsertSnapshotLabel).toHaveBeenCalledWith(stubPool, {
      conversationId: 'conv-1',
      appId: 'app_1',
      snapshotId: 'snap-123',
      label: 'Add a button',
      autoGenerated: true,
    });
    // Short message → no gateway call needed
    expect(gatewayChatSpy).not.toHaveBeenCalled();
  });

  it('uses the gateway summary as the label when the user message is long', async () => {
    const longMessage =
      'Please refactor the entire dashboard layout to use a new sidebar component, update the routing, ' +
      'and make sure the mobile breakpoint still works correctly across all pages.';
    expect(longMessage.length).toBeGreaterThanOrEqual(120);

    global.fetch = vi.fn()
      .mockResolvedValueOnce(toolCallPass('call-w', 'write_file', `{"app_id":"app_1","path":"src/App.tsx","content":"code"}`))
      .mockResolvedValueOnce(textPass('Refactored the layout.'));

    const cache = new WorkingTreeCache();
    const flushSpy = vi.fn().mockResolvedValue({ pushed: 1, deleted: 0, newSnapshotId: 'snap-456' });
    const repoSync = {
      pullLatest: vi.fn().mockResolvedValue({ hydrated: true }),
      flush: flushSpy,
    };

    const gatewayChatSpy = vi.fn().mockResolvedValue('Refactor dashboard layout and sidebar');
    const snapshotTitleGatewayFactory = vi.fn().mockReturnValue({ chat: gatewayChatSpy });

    await collect(
      runAgentTurn(
        { ...baseInput, userMessage: longMessage },
        {
          cache,
          repoSync: repoSync as any,
          recordUsage: vi.fn().mockResolvedValue(undefined),
          loadTemplate: vi.fn().mockResolvedValue([]),
          snapshotTitleGatewayFactory,
        },
      ),
    );

    expect(gatewayChatSpy).toHaveBeenCalledTimes(1);
    expect(mockUpsertSnapshotLabel).toHaveBeenCalledWith(stubPool, {
      conversationId: 'conv-1',
      appId: 'app_1',
      snapshotId: 'snap-456',
      label: 'Refactor dashboard layout and sidebar',
      autoGenerated: true,
    });
  });

  it('does not call upsertSnapshotLabel when flush returns a null newSnapshotId (no-op flush)', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(toolCallPass('call-w', 'write_file', '{"app_id":"app_1","path":"src/App.tsx","content":"code"}'))
      .mockResolvedValueOnce(textPass('done'));

    const cache = new WorkingTreeCache();
    const flushSpy = vi.fn().mockResolvedValue({ pushed: 0, deleted: 0, newSnapshotId: null });
    const repoSync = {
      pullLatest: vi.fn().mockResolvedValue({ hydrated: true }),
      flush: flushSpy,
    };

    await collect(
      runAgentTurn(baseInput, {
        cache,
        repoSync: repoSync as any,
        recordUsage: vi.fn().mockResolvedValue(undefined),
        loadTemplate: vi.fn().mockResolvedValue([]),
      }),
    );

    expect(mockUpsertSnapshotLabel).not.toHaveBeenCalled();
  });

  it('does not let a labeling failure (gateway throw + store throw) escape the turn or block done/SSE completion', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(toolCallPass('call-w', 'write_file', '{"app_id":"app_1","path":"src/App.tsx","content":"code"}'))
      .mockResolvedValueOnce(textPass('done'));

    const cache = new WorkingTreeCache();
    const flushSpy = vi.fn().mockResolvedValue({ pushed: 1, deleted: 0, newSnapshotId: 'snap-789' });
    const repoSync = {
      pullLatest: vi.fn().mockResolvedValue({ hydrated: true }),
      flush: flushSpy,
    };

    mockUpsertSnapshotLabel.mockRejectedValueOnce(new Error('db down'));
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events = await collect(
      runAgentTurn(baseInput, {
        cache,
        repoSync: repoSync as any,
        recordUsage: vi.fn().mockResolvedValue(undefined),
        loadTemplate: vi.fn().mockResolvedValue([]),
      }),
    );

    // The turn still completes normally — labeling failures never surface as
    // error frames or break the SSE stream.
    expect(events.find((e) => e.type === 'assistant_message')).toBeDefined();
    expect(consoleWarnSpy).toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Plan 3e Task 2: conversation auto-titling
// ---------------------------------------------------------------------------

describe('runAgentTurn — conversation auto-titling (Plan 3e Task 2)', () => {
  const stubConversation = {
    id: 'conv-1',
    userId: 'user-1',
    title: 'New conversation',
    model: 'claude-3-5-sonnet',
    createdAt: new Date(),
    updatedAt: new Date(),
    lastMessageAt: null,
  };

  it('generates and persists a title on the first assistant turn, and emits title_updated', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      gatewayResponse([
        { choices: [{ delta: { content: 'Sure, scaffolding a todo app now.' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    );

    mockGetConversation.mockResolvedValueOnce(stubConversation);
    const gatewayChatSpy = vi.fn().mockResolvedValue('Todo App Setup');
    const snapshotTitleGatewayFactory = vi.fn().mockReturnValue({ chat: gatewayChatSpy });
    mockUpdateConversationTitle.mockResolvedValueOnce({ ...stubConversation, title: 'Todo App Setup' });

    const events = await collect(
      runAgentTurn(
        { ...baseInput, userMessage: 'Help me build a todo app' },
        { snapshotTitleGatewayFactory },
      ),
    );

    expect(mockGetConversation).toHaveBeenCalledWith(stubPool, 'conv-1', 'user-1');
    expect(gatewayChatSpy).toHaveBeenCalledTimes(1);
    const callArg = gatewayChatSpy.mock.calls[0][0] as { prompt: string };
    expect(callArg.prompt).toContain('Help me build a todo app');
    expect(callArg.prompt).toContain('Sure, scaffolding a todo app now.');

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      stubPool,
      'conv-1',
      'user-1',
      'Todo App Setup',
    );

    const titleEvent = events.find((e) => e.type === 'title_updated');
    expect(titleEvent).toEqual({ type: 'title_updated', title: 'Todo App Setup' });
  });

  it('does not touch the title when the conversation already has a non-default title', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      gatewayResponse([
        { choices: [{ delta: { content: 'Done.' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    );

    mockGetConversation.mockResolvedValueOnce({ ...stubConversation, title: 'Renamed by user' });
    const gatewayChatSpy = vi.fn();
    const snapshotTitleGatewayFactory = vi.fn().mockReturnValue({ chat: gatewayChatSpy });

    const events = await collect(
      runAgentTurn(baseInput, { snapshotTitleGatewayFactory }),
    );

    expect(gatewayChatSpy).not.toHaveBeenCalled();
    expect(mockUpdateConversationTitle).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'title_updated')).toBeUndefined();
  });

  it('silently skips the title update when the gateway call times out / errors', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      gatewayResponse([
        { choices: [{ delta: { content: 'Done.' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    );

    mockGetConversation.mockResolvedValueOnce(stubConversation);
    const gatewayChatSpy = vi.fn().mockRejectedValue(new Error('timeout'));
    const snapshotTitleGatewayFactory = vi.fn().mockReturnValue({ chat: gatewayChatSpy });

    const events = await collect(
      runAgentTurn(baseInput, { snapshotTitleGatewayFactory }),
    );

    expect(mockUpdateConversationTitle).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'title_updated')).toBeUndefined();
    // Turn still completes normally.
    expect(events.find((e) => e.type === 'assistant_message')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Plan 3b Task 2: sensitivity gate
// ---------------------------------------------------------------------------

/** Single-tool-call SSE pass for a given tool name + JSON-stringified args. */
function toolCallPassFor(callId: string, name: string, argsJson: string) {
  return gatewayResponse([
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, id: callId, function: { name, arguments: '' } }] }, finish_reason: null },
      ],
    },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsJson } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
}

describe('runAgentTurn — sensitivity gate (Plan 3b Task 2)', () => {
  it('gates an untrusted destructive call: creates an approval, emits approval_required, never dispatches MCP, and terminates the turn without done', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      toolCallPassFor('call-del', 'manage_app', '{"action":"delete","id":"app_1"}'),
    );

    mockCheckTrust.mockResolvedValueOnce(false);
    mockCreateApproval.mockResolvedValueOnce({
      id: 'approval-1',
      conversationId: 'conv-1',
      turnMessageId: 'msg-approval-1',
      toolName: 'manage_app',
      toolArgs: { action: 'delete', id: 'app_1' },
      sensitivity: 'destructive',
      status: 'pending',
      trustScope: null,
      denyReason: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });

    const events = await collect(runAgentTurn(baseInput));

    expect(mockCheckTrust).toHaveBeenCalledWith(stubPool, 'conv-1', 'manage_app');
    expect(mockCreateApproval).toHaveBeenCalledWith(
      stubPool,
      expect.objectContaining({
        conversationId: 'conv-1',
        toolName: 'manage_app',
        toolArgs: { action: 'delete', id: 'app_1' },
        sensitivity: 'destructive',
      }),
    );

    expect(events).toEqual([
      {
        type: 'approval_required',
        approval_id: 'approval-1',
        tool_name: 'manage_app',
        args: { action: 'delete', id: 'app_1' },
        sensitivity: 'destructive',
      },
    ]);

    // Never reaches MCP dispatch.
    expect(mockCallMcpTool).not.toHaveBeenCalled();
    // Turn is paused, not completed.
    expect(events.find((e) => e.type === 'done')).toBeUndefined();

    // The paused assistant tool-call row is persisted with the pending approval id.
    const pausedRow = mockAppendMessage.mock.calls.find(
      ([, , msg]) => (msg as { toolName?: string }).toolName === 'manage_app',
    );
    expect(pausedRow).toBeDefined();
    expect((pausedRow![2] as { pendingApprovalId?: string }).pendingApprovalId).toBe('approval-1');
  });

  it('leaves a safe tool call unaffected (no trust check, no approval, dispatches MCP normally)', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(toolCallPassFor('call-list', 'manage_app', '{"action":"list"}'))
      .mockResolvedValueOnce(gatewayResponse([
        { choices: [{ delta: { content: 'You have no apps.' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]));

    mockCallMcpTool.mockResolvedValueOnce({ ok: true, result: { apps: [] } });

    const events = await collect(runAgentTurn(baseInput));

    expect(mockCheckTrust).not.toHaveBeenCalled();
    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect(mockCallMcpTool).toHaveBeenCalledWith('manage_app', { action: 'list' }, 'test-jwt');
    expect(events.find((e) => e.type === 'approval_required')).toBeUndefined();
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });

  it('bypasses the gate for a trusted destructive call (checkTrust true): dispatches MCP normally, no approval row', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(toolCallPassFor('call-del2', 'manage_app', '{"action":"delete","id":"app_1"}'))
      .mockResolvedValueOnce(gatewayResponse([
        { choices: [{ delta: { content: 'Deleted.' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]));

    mockCheckTrust.mockResolvedValueOnce(true);
    mockCallMcpTool.mockResolvedValueOnce({ ok: true, result: { deleted: true } });

    const events = await collect(runAgentTurn(baseInput));

    expect(mockCheckTrust).toHaveBeenCalledWith(stubPool, 'conv-1', 'manage_app');
    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect(mockCallMcpTool).toHaveBeenCalledWith('manage_app', { action: 'delete', id: 'app_1' }, 'test-jwt');
    expect(events.find((e) => e.type === 'approval_required')).toBeUndefined();
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });
});
