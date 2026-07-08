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
  ]),
  isFileOpTool: (name: string) =>
    name === 'write_file' || name === 'read_file' || name === 'list_files' || name === 'delete_file',
  isDeployTool: (name: string) => name === 'deploy_frontend',
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

// ---------------------------------------------------------------------------
// Task 7: builder-mode integration tests
// ---------------------------------------------------------------------------

import { WorkingTreeCache } from '../working-tree.js';
import { createFileOps } from '../file-ops.js';
import { createDeployer } from '../deploy.js';

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
