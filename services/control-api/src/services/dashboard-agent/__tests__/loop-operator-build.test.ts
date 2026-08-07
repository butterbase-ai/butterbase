/**
 * PHASE 3 — the operator's one new model-facing capability: `build_app`.
 *
 * What it is for: before this, nothing type-checked or compiled what the
 * operator wrote. Functions had no build at all; frontends compiled only
 * inside a deploy, so the agent learned it was wrong by SHIPPING. `build_app`
 * puts a real compiler between "write" and "deploy" and hands its output back.
 *
 * Structured to mirror loop-operator-policy.test.ts, and for the same reason:
 * the REAL tool-catalog.ts and operator-policy.ts, only I/O mocked. A test of a
 * safety control run against a hand-written copy of the table proves nothing.
 *
 * Three things this file pins, in descending order of how badly they matter:
 *
 *  1. THE CREDENTIAL NEVER CROSSES. `buildExecutor` is the function that talks
 *     to the sandbox; the object it receives is asserted to contain no service
 *     key, in any field, on every path.
 *  2. NO EXECUTOR, NO TOOL. Identical to `run_sandbox_code`'s rule: absence of
 *     a sandbox means the capability is UNREACHABLE, never "runs somewhere
 *     else". There is no host-side build fallback and there must never be one.
 *  3. A FAILING BUILD IS A RESULT, NOT A TURN FAILURE. Compiler errors are the
 *     payload; a turn that dies on a red build has learned nothing.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type pg from 'pg';

vi.mock('../store.js', () => ({
  appendMessage: vi.fn(),
  listMessages: vi.fn(),
  getRecentToolArgs: vi.fn(),
  upsertSnapshotLabel: vi.fn(),
  getConversation: vi.fn(),
  updateConversationTitle: vi.fn(),
}));

vi.mock('../mcp-client.js', () => ({ callMcpTool: vi.fn() }));
vi.mock('../approvals-store.js', () => ({ createApproval: vi.fn(), checkTrust: vi.fn() }));

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import * as approvalsStoreModule from '../approvals-store.js';
import { getToolCatalog, OPERATOR_BUILD_TOOL, isBuildAppTool } from '../tool-catalog.js';
import { operatorUserId } from '../operator-store.js';
import { OPERATOR_LOCAL_TOOLS, operatorToolTier } from '../operator-policy.js';
import { runAgentTurn, type LoopEvent, type BuildExecutor } from '../loop.js';
import { WorkingTreeCache } from '../working-tree.js';

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockGetConversation = storeModule.getConversation as MockedFunction<typeof storeModule.getConversation>;
const mockUpdateConversationTitle = storeModule.updateConversationTitle as MockedFunction<typeof storeModule.updateConversationTitle>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;
const mockCheckTrust = approvalsStoreModule.checkTrust as MockedFunction<typeof approvalsStoreModule.checkTrust>;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_USER = operatorUserId(ORG_ID);
const APP = 'app-1';
/** The thing that must never reach the sandbox. Shaped like a real one. */
const SERVICE_KEY = 'bb_sk_liveDEADBEEFdeadbeefDEADBEEFdeadbeef';

const stubPool = {} as pg.Pool;
const stubMessage = {
  id: 'msg-stub', conversationId: 'conv-1', role: 'user' as const, content: '',
  toolCallId: null, toolName: null, toolArgs: null, toolResult: null,
  modelUsed: null, createdAt: new Date(),
};

async function collect(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeSseStream(deltas: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = deltas.map((d) => `data: ${JSON.stringify(d)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(encoder.encode(lines)); c.close(); },
  });
}
const gatewayResponse = (deltas: object[]) => ({ ok: true, body: makeSseStream(deltas) } as unknown as Response);

function oneToolCallThenStop(name: string, args: unknown) {
  const bodies: string[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init?: unknown) => {
    bodies.push((init as { body?: string } | undefined)?.body ?? '');
    if (bodies.length === 1) {
      return gatewayResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name, arguments: '' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]);
    }
    return gatewayResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { bodies };
}

function toolNamesSent(body: string): string[] {
  const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string }; name?: string }> };
  return (parsed.tools ?? []).map((t) => t.function?.name ?? t.name ?? '');
}

const okBuild = {
  ok: true, step: 'done' as const, exitCode: 0,
  stdout: 'vite v5.0.0 building for production...\n42 modules transformed.',
  stderr: '', installSkipped: false, truncated: false, timedOut: false, durationMs: 91_000,
};

/**
 * A working tree with real content, plus a hydrator factory over it. The
 * hydrator is injected rather than mocked at the module boundary so the test
 * can inspect exactly what the loop hands the executor.
 */
function withTree(files: Record<string, string> = { 'package.json': '{}', 'src/App.tsx': 'export default () => null' }) {
  const cache = new WorkingTreeCache();
  for (const [p, c] of Object.entries(files)) cache.write('conv-1', APP, p, c);
  const buildHydratorFactory = () => ({
    hydrate: vi.fn(async () => ({
      files: Object.keys(files).map((p) => ({ path: p, url: `https://s3.example/blob/${encodeURIComponent(p)}?sig=abc` })),
      installKey: 'a'.repeat(64),
      fileCount: Object.keys(files).length,
      totalBytes: 100,
    })),
  });
  return { cache, buildHydratorFactory };
}

function operatorInput(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1',
    userId: OPERATOR_USER,
    jwt: SERVICE_KEY,
    userMessage: 'Scheduled wake.',
    model: 'claude-sonnet-4-5',
    pool: stubPool,
    organizationId: ORG_ID,
    traceId: 'trace-build-1',
    ...overrides,
  };
}

function humanInput(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1', userId: 'cognito-sub-abc', jwt: 'user-jwt',
    userMessage: 'Hello', model: 'claude-sonnet-4-5', pool: stubPool,
    organizationId: ORG_ID, ...overrides,
  };
}

const resultOf = (events: LoopEvent[]) =>
  events.find((e) => e.type === 'tool_result') as Extract<LoopEvent, { type: 'tool_result' }> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendMessage.mockResolvedValue(stubMessage);
  mockListMessages.mockResolvedValue([]);
  mockGetRecentToolArgs.mockResolvedValue([]);
  mockGetConversation.mockResolvedValue(null);
  mockUpdateConversationTitle.mockResolvedValue(null);
  mockCheckTrust.mockResolvedValue(false);
  mockCallMcpTool.mockResolvedValue({ ok: true, result: { content: [{ type: 'text', text: '{}' }] } } as never);
});

// ---------------------------------------------------------------------------
// the tool exists and is classified
// ---------------------------------------------------------------------------

describe('build_app — catalogue and policy registration', () => {
  it('is in the catalogue, operator-only', () => {
    const spec = getToolCatalog().find((t) => t.name === OPERATOR_BUILD_TOOL);
    expect(spec).toBeDefined();
    expect(spec!.operatorOnly).toBe(true);
    expect(isBuildAppTool(OPERATOR_BUILD_TOOL)).toBe(true);
    expect(isBuildAppTool('build_apps')).toBe(false);
  });

  it('is a LOOP-INTERNAL tool — there is no MCP tool by this name', () => {
    expect(OPERATOR_LOCAL_TOOLS.has(OPERATOR_BUILD_TOOL)).toBe(true);
  });

  it('carries a deliberate tier', () => {
    // The argument for which tier lives in operator-policy.ts. This only pins
    // that the decision was made rather than inherited from the fallback.
    expect(['allow', 'approval']).toContain(operatorToolTier(OPERATOR_BUILD_TOOL));
  });

  it("tells the model it may be ABSENT, so it doesn't plan around a tool it lacks", () => {
    const spec = getToolCatalog().find((t) => t.name === OPERATOR_BUILD_TOOL)!;
    expect(spec.description).toMatch(/absent|not offered|may not be available/i);
    // And that it does not deploy — the one confusion that would make the
    // operator ship instead of check.
    expect(spec.description).toMatch(/deploy/i);
  });
});

// ---------------------------------------------------------------------------
// no executor, no tool
// ---------------------------------------------------------------------------

describe('build_app — availability follows the sandbox, exactly like run_sandbox_code', () => {
  it('is WITHHELD from the catalogue when no buildExecutor is supplied', async () => {
    const { bodies } = oneToolCallThenStop('select_rows', { app_id: APP });
    await collect(runAgentTurn(operatorInput()));
    expect(toolNamesSent(bodies[0])).not.toContain(OPERATOR_BUILD_TOOL);
  });

  it('is offered once a buildExecutor is supplied', async () => {
    const { bodies } = oneToolCallThenStop('select_rows', { app_id: APP });
    const buildExecutor = vi.fn(async () => okBuild) as unknown as BuildExecutor;
    await collect(runAgentTurn(operatorInput({ buildExecutor })));
    expect(toolNamesSent(bodies[0])).toContain(OPERATOR_BUILD_TOOL);
    // Merely supplying it must not invoke it.
    expect(buildExecutor).not.toHaveBeenCalled();
  });

  it('is never offered to a human conversation, even with a buildExecutor supplied', async () => {
    const { bodies } = oneToolCallThenStop('manage_app', { action: 'list' });
    const buildExecutor = vi.fn(async () => okBuild) as unknown as BuildExecutor;
    await collect(runAgentTurn(humanInput({ buildExecutor })));
    expect(toolNamesSent(bodies[0])).not.toContain(OPERATOR_BUILD_TOOL);
  });

  it('THE SAFETY CASE: a hallucinated call with no executor is refused, never built on the host', async () => {
    oneToolCallThenStop(OPERATOR_BUILD_TOOL, { app_id: APP });
    const events = await collect(runAgentTurn(operatorInput()));
    expect(mockCallMcpTool).not.toHaveBeenCalled();
    expect(resultOf(events)!.error).toBeDefined();
    expect(resultOf(events)!.result).toBeUndefined();
  });

  it('is refused on a human conversation even if an executor were somehow supplied', async () => {
    oneToolCallThenStop(OPERATOR_BUILD_TOOL, { app_id: APP });
    const buildExecutor = vi.fn(async () => okBuild) as unknown as BuildExecutor;
    const events = await collect(runAgentTurn(humanInput({ buildExecutor })));
    expect(buildExecutor).not.toHaveBeenCalled();
    expect(resultOf(events)!.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe('build_app — dispatch', () => {
  it('hydrates, runs the build, and returns the compiler output', async () => {
    oneToolCallThenStop(OPERATOR_BUILD_TOOL, { app_id: APP });
    const { cache, buildHydratorFactory } = withTree();
    const buildExecutor = vi.fn(async () => okBuild) as unknown as BuildExecutor;

    const events = await collect(runAgentTurn(
      operatorInput({ buildExecutor }),
      { cache, buildHydratorFactory },
    ));

    expect(buildExecutor).toHaveBeenCalledTimes(1);
    expect(mockCallMcpTool).not.toHaveBeenCalled(); // in-process, never MCP
    const r = resultOf(events)!;
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ ok: true, stdout: expect.stringContaining('42 modules') });
  });

  it('passes the presigned urls and the install key to the executor', async () => {
    oneToolCallThenStop(OPERATOR_BUILD_TOOL, { app_id: APP });
    const { cache, buildHydratorFactory } = withTree();
    const buildExecutor = vi.fn(async () => okBuild) as unknown as BuildExecutor;

    await collect(runAgentTurn(operatorInput({ buildExecutor }), { cache, buildHydratorFactory }));

    const req = (buildExecutor as unknown as MockedFunction<BuildExecutor>).mock.calls[0][0];
    expect(req.installKey).toMatch(/^[a-f0-9]{64}$/);
    expect(req.files.every((f) => f.url.startsWith('https://'))).toBe(true);
    expect(req.workspaceId).toBe(APP);
  });

  it('A RED BUILD IS A RESULT, not a turn failure', async () => {
    // The whole point of the phase. Losing the turn on a compile error would
    // throw away everything the operator did before it.
    oneToolCallThenStop(OPERATOR_BUILD_TOOL, { app_id: APP });
    const { cache, buildHydratorFactory } = withTree();
    const buildExecutor = vi.fn(async () => ({
      ...okBuild, ok: false, step: 'build' as const, exitCode: 2,
      stdout: "src/App.tsx(12,3): error TS2322: Type 'number' is not assignable to type 'string'.",
    })) as unknown as BuildExecutor;

    const events = await collect(runAgentTurn(operatorInput({ buildExecutor }), { cache, buildHydratorFactory }));

    const r = resultOf(events)!;
    expect(r.error).toBeUndefined();          // NOT an error — a build report
    // snake_case: the model sees the same casing every other tool result uses.
    expect(r.result).toMatchObject({ ok: false, exit_code: 2 });
    expect(JSON.stringify(r.result)).toContain('TS2322');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('requires app_id', async () => {
    oneToolCallThenStop(OPERATOR_BUILD_TOOL, {});
    const { cache, buildHydratorFactory } = withTree();
    const buildExecutor = vi.fn(async () => okBuild) as unknown as BuildExecutor;
    const events = await collect(runAgentTurn(operatorInput({ buildExecutor }), { cache, buildHydratorFactory }));
    expect(buildExecutor).not.toHaveBeenCalled();
    expect(resultOf(events)!.error).toMatch(/app_id/);
  });

  it('reports a hydration failure as a tool error and does not build', async () => {
    oneToolCallThenStop(OPERATOR_BUILD_TOOL, { app_id: APP });
    const { cache } = withTree();
    const buildHydratorFactory = () => ({ hydrate: vi.fn(async () => { throw new Error('repo 403'); }) });
    const buildExecutor = vi.fn(async () => okBuild) as unknown as BuildExecutor;

    const events = await collect(runAgentTurn(operatorInput({ buildExecutor }), { cache, buildHydratorFactory }));

    expect(buildExecutor).not.toHaveBeenCalled();
    expect(resultOf(events)!.error).toContain('403');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('surfaces an executor rejection as an ordinary tool error', async () => {
    oneToolCallThenStop(OPERATOR_BUILD_TOOL, { app_id: APP });
    const { cache, buildHydratorFactory } = withTree();
    const buildExecutor = vi.fn(async () => { throw new Error('sandbox went away'); }) as unknown as BuildExecutor;

    const events = await collect(runAgentTurn(operatorInput({ buildExecutor }), { cache, buildHydratorFactory }));

    expect(resultOf(events)!.error).toContain('sandbox went away');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('DOES NOT DEPLOY — no manage_frontend call is made', async () => {
    // Build and deploy are separate verbs on purpose. The from-source deploy
    // path is untouched by this phase; a build that deployed would make the
    // "check before you ship" affordance the thing that ships.
    oneToolCallThenStop(OPERATOR_BUILD_TOOL, { app_id: APP });
    const { cache, buildHydratorFactory } = withTree();
    const buildExecutor = vi.fn(async () => okBuild) as unknown as BuildExecutor;

    await collect(runAgentTurn(operatorInput({ buildExecutor }), { cache, buildHydratorFactory }));

    expect(mockCallMcpTool.mock.calls.map((c) => c[0])).not.toContain('manage_frontend');
  });
});

// ---------------------------------------------------------------------------
// THE credential requirement
// ---------------------------------------------------------------------------

describe('credential — the service key never reaches anything sandbox-bound', () => {
  /**
   * `buildExecutor` is the boundary: everything it receives is on its way to a
   * MicroVM running model-authored code with unrestricted egress. The
   * operator's key can wipe the app repo (`DELETE /v1/:app_id/repo` shares
   * `authorizeRepoWrite` with commit), so "it happens not to be in the field I
   * checked" is not good enough — the whole argument object is serialised and
   * searched, by value AND by shape.
   */
  const assertClean = (req: unknown) => {
    const s = JSON.stringify(req);
    expect(s).not.toContain(SERVICE_KEY);
    expect(s).not.toContain('bb_sk_');
    expect(s).not.toMatch(/authorization|bearer|\bjwt\b/i);
  };

  it('is absent from the buildExecutor argument on a green build', async () => {
    oneToolCallThenStop(OPERATOR_BUILD_TOOL, { app_id: APP });
    const { cache, buildHydratorFactory } = withTree();
    const buildExecutor = vi.fn(async () => okBuild) as unknown as BuildExecutor;

    await collect(runAgentTurn(operatorInput({ buildExecutor }), { cache, buildHydratorFactory }));

    assertClean((buildExecutor as unknown as MockedFunction<BuildExecutor>).mock.calls[0][0]);
  });

  it('is absent on a red build too', async () => {
    oneToolCallThenStop(OPERATOR_BUILD_TOOL, { app_id: APP });
    const { cache, buildHydratorFactory } = withTree();
    const buildExecutor = vi.fn(async () => ({ ...okBuild, ok: false, exitCode: 1 })) as unknown as BuildExecutor;

    await collect(runAgentTurn(operatorInput({ buildExecutor }), { cache, buildHydratorFactory }));

    assertClean((buildExecutor as unknown as MockedFunction<BuildExecutor>).mock.calls[0][0]);
  });

  it('the executor argument carries EXACTLY the fields the sandbox needs', async () => {
    // A closed shape, so a future field cannot arrive on the guest side of the
    // boundary without somebody editing this list and having to think about it.
    oneToolCallThenStop(OPERATOR_BUILD_TOOL, { app_id: APP });
    const { cache, buildHydratorFactory } = withTree();
    const buildExecutor = vi.fn(async () => okBuild) as unknown as BuildExecutor;

    await collect(runAgentTurn(operatorInput({ buildExecutor }), { cache, buildHydratorFactory }));

    const req = (buildExecutor as unknown as MockedFunction<BuildExecutor>).mock.calls[0][0];
    expect(Object.keys(req).sort()).toEqual(['files', 'installKey', 'workspaceId']);
    for (const f of req.files) expect(Object.keys(f).sort()).toEqual(['path', 'url']);
  });

  it('does not send file CONTENT to the sandbox — presigned urls only', async () => {
    oneToolCallThenStop(OPERATOR_BUILD_TOOL, { app_id: APP });
    const { cache, buildHydratorFactory } = withTree({
      'package.json': '{}',
      'src/secrets.ts': 'const SENTINEL = "sentinel-content-value"',
    });
    const buildExecutor = vi.fn(async () => okBuild) as unknown as BuildExecutor;

    await collect(runAgentTurn(operatorInput({ buildExecutor }), { cache, buildHydratorFactory }));

    const req = (buildExecutor as unknown as MockedFunction<BuildExecutor>).mock.calls[0][0];
    expect(JSON.stringify(req)).not.toContain('sentinel-content-value');
  });
});
