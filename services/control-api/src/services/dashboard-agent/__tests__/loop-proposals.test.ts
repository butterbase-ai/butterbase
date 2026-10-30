/** Real loop policy, with I/O mocked and server preparation injected. */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type pg from 'pg';
import { ApiKeyService } from '../../api-key-service.js';
import { AppResolver, AppNotFoundError } from '../../app-resolver.js';
vi.mock('../../api-key-service.js', () => ({ ApiKeyService: { validateApiKey: vi.fn() } }));

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
  listPendingGatedCalls: vi.fn(async () => []),
  SUBSTRATE_ESCALATION_TOOL: 'manage_substrate',
  isValidSubstrateActionId: (id: unknown) => typeof id === 'string' && id.startsWith('act_'),
}));

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import * as approvalsStoreModule from '../approvals-store.js';
import { getToolCatalog, OPERATOR_SANDBOX_CODE_TOOL, OPERATOR_BUILD_TOOL, SKILL_CREATOR_TOOL, RUN_SKILL_SCRIPT_TOOL } from '../tool-catalog.js';
import { operatorUserId } from '../operator-store.js';
import { isOperatorToolAllowed } from '../operator-policy.js';
import { runAgentTurn, getSharedWorkingTreeCache, type LoopEvent } from '../loop.js';
import type { DeployTreeStore } from '../deploy-tree-store.js';
import type { WorkingTree } from '../working-tree.js';
import { setApprovalProposalProvider, PreparedProposalSchema } from '../approval-proposal.js';
import { persistPreparedApproval } from '../proposal-store.js';
import { findParkedProposalIntent } from '../proposal-store.js';
vi.mock('../proposal-store.js', () => ({ persistPreparedApproval: vi.fn(), findParkedProposalIntent: vi.fn(async () => null) }));
vi.mock('@butterbase/mcp-server/tool-validation', () => ({ validateRegisteredToolArguments: vi.fn(async (name, args) => ({ toolName: name, args })) }));

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockGetConversation = storeModule.getConversation as MockedFunction<typeof storeModule.getConversation>;
const mockUpdateConversationTitle = storeModule.updateConversationTitle as MockedFunction<typeof storeModule.updateConversationTitle>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;
const mockCreateApproval = approvalsStoreModule.createApproval as MockedFunction<typeof approvalsStoreModule.createApproval>;
const mockCheckTrust = approvalsStoreModule.checkTrust as MockedFunction<typeof approvalsStoreModule.checkTrust>;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_USER = operatorUserId(ORG_ID);
const HUMAN_USER = 'cognito-sub-abc';

const stubPool = {} as pg.Pool;

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

async function collect(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeSseStream(deltas: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = deltas.map((d) => `data: ${JSON.stringify(d)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

function gatewayResponse(deltas: object[]) {
  return { ok: true, body: makeSseStream(deltas) } as unknown as Response;
}

/** One gateway pass that emits a single tool call, then a pass that stops. */
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

/** Tool names the gateway was offered on the first pass. */
function toolNamesSent(body: string): string[] {
  const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string }; name?: string }> };
  return (parsed.tools ?? []).map((t) => t.function?.name ?? t.name ?? '');
}

function operatorInput(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1',
    userId: OPERATOR_USER,
    jwt: 'operator-service-key',
    userMessage: 'Scheduled wake.',
    model: 'claude-sonnet-4-5',
    pool: stubPool,
    organizationId: ORG_ID,
    // D1: every real operator turn carries a trace id (see operator-turn.ts).
    // Set here Ã¢â‚¬â€ not left undefined Ã¢â‚¬â€ so the dispatch assertions below can
    // pin that it is actually threaded to callMcpTool as a 5th argument,
    // not silently dropped.
    traceId: 'trace-test-1',
    ...overrides,
  };
}

function humanInput(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1',
    userId: HUMAN_USER,
    jwt: 'user-jwt',
    userMessage: 'Hello',
    model: 'claude-sonnet-4-5',
    pool: stubPool,
    organizationId: ORG_ID,
    ...overrides,
  };
}

beforeEach(() => {
  setApprovalProposalProvider(null);
  vi.clearAllMocks();
  mockAppendMessage.mockResolvedValue(stubMessage);
  mockListMessages.mockResolvedValue([]);
  mockGetRecentToolArgs.mockResolvedValue([]);
  mockGetConversation.mockResolvedValue(null);
  mockUpdateConversationTitle.mockResolvedValue(null);
  mockCheckTrust.mockResolvedValue(false);
  mockCallMcpTool.mockResolvedValue({ ok: true, result: { content: [{ type: 'text', text: '{}' }] } } as never);
  mockCreateApproval.mockResolvedValue({
    id: 'approval-1',
    conversationId: 'conv-1',
    turnMessageId: 'msg-1',
    toolName: 'x',
    toolArgs: {},
    sensitivity: 'destructive',
    status: 'pending',
    trustScope: null,
    denyReason: null,
    createdAt: 'now',
    resolvedAt: null,
  } as never);
});

describe('structured proposal gate', () => {
  it('creates no Office owner gate when its required preparation provider is absent', async () => {
    setApprovalProposalProvider(null);
    oneToolCallThenStop('manage_substrate', { action: 'cancel_outbox', outbox_id: 'obx_synthetic' });
    const events = await collect(runAgentTurn(operatorInput({ accessGuard: async () => ({ allowed: true, approvalMode: 'consequential', reason: null }) })));
    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect(events.some(e => e.type === 'tool_result' && JSON.stringify(e).includes('proposal_unavailable'))).toBe(true);
  });
  const operation = { tool: 'manage_substrate', arguments: { action: 'cancel_outbox', outbox_id: 'obx_synthetic' } };
  const ready = () => PreparedProposalSchema.parse({ version: 1, source: 'explicit', preparedAt: new Date().toISOString(), intentFingerprint: 'a'.repeat(64), operationFingerprint: 'b'.repeat(64), reason: { text: 'Obsolete draft.', attribution: 'operator' }, evidence: [], preview: { title: 'Cancel draft?', summary: 'Stops delivery.', target: { label: 'Draft', reference: 'obx_synthetic' }, effects: ['Stops attempts.'], fields: [] }, preconditions: [{ kind: 'outbox', referenceId: 'obx_synthetic', fingerprint: 'c'.repeat(64) }] });
  function install(result: any = { status: 'ready', proposal: ready() }) {
    const prepare = vi.fn(async () => result);
    setApprovalProposalProvider({ enabled: () => true, prepare, revalidate: async () => ({ status: 'valid' }) });
    vi.mocked(persistPreparedApproval).mockResolvedValue({ kind: 'created', approval: { id: 'prepared-approval' } as any });
    return prepare;
  }
  it('asks the model for explicit intent instead of presenting a vague direct gate', async () => {
    const prepare = install();
    oneToolCallThenStop(operation.tool, operation.arguments);
    const events = await collect(runAgentTurn(operatorInput()));
    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect(persistPreparedApproval).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(events.some(e => e.type === 'tool_result' && JSON.stringify(e).includes('proposal_incomplete'))).toBe(true);
  });
  it('prepares the underlying operation but pauses the original wrapper call', async () => {
    const prepare = install();
    oneToolCallThenStop('propose_action', { operation, reason: 'Obsolete draft.' });
    const events = await collect(runAgentTurn(operatorInput()));
    expect(prepare).toHaveBeenCalledOnce();
    expect(persistPreparedApproval).toHaveBeenCalledWith(stubPool, expect.objectContaining({ operation: expect.objectContaining({ toolName: operation.tool, args: operation.arguments }), message: expect.objectContaining({ toolName: 'propose_action', callId: 'call-1' }) }));
    expect(events.some(e => e.type === 'approval_required')).toBe(true);
    expect(mockCallMcpTool.mock.calls.filter(([name, args]) => !(name === 'manage_substrate' && (args as any)?.action === 'get_settings'))).toHaveLength(0);
  });
  it.each([{ status: 'needs_input', code: 'proposal_incomplete', missing: ['target'] }, { status: 'blocked', code: 'proposal_unreviewable', message: 'Unavailable.' }])('creates no owner gate on incomplete preparation', async result => {
    install(result);
    oneToolCallThenStop('propose_action', { operation, reason: 'Obsolete draft.' });
    const events = await collect(runAgentTurn(operatorInput()));
    expect(persistPreparedApproval).not.toHaveBeenCalled();
    expect(mockCallMcpTool.mock.calls.filter(([name, args]) => !(name === 'manage_substrate' && (args as any)?.action === 'get_settings'))).toHaveLength(0);
    expect(events.some(e => e.type === 'tool_result' && JSON.stringify(e).includes(result.code))).toBe(true);
  });
  it('does not use the wrapper to execute automatic operations', async () => {
    install();
    oneToolCallThenStop('propose_action', { operation: { tool: 'manage_substrate', arguments: { action: 'get_settings' } }, reason: 'Read settings.' });
    const events = await collect(runAgentTurn(operatorInput()));
    expect(mockCallMcpTool.mock.calls.filter(([name, args]) => !(name === 'manage_substrate' && (args as any)?.action === 'get_settings'))).toHaveLength(0);
    expect(persistPreparedApproval).not.toHaveBeenCalled();
    expect(events.some(e => e.type === 'tool_result' && JSON.stringify(e).includes('proposal_not_required'))).toBe(true);
  });
  it('records trusted escalation as a normal result and creates no vague owner gate', async () => {
    install();
    oneToolCallThenStop('manage_substrate', { action: 'propose', capability: 'record_learning', payload: { title: 'Synthetic', content: 'Synthetic' } });
    mockCallMcpTool.mockImplementation(async (_name, args: any) => ({ ok: true, result: { content: [{ type: 'text', text: JSON.stringify(args?.action === 'propose' ? { action_id: 'act_synthetic', requires_approval: true } : {}) }] } }));
    const events = await collect(runAgentTurn(operatorInput()));
    expect(events.some(e => e.type === 'approval_required')).toBe(false);
    expect(events.some(e => e.type === 'tool_result' && JSON.stringify(e).includes('parkedProposal'))).toBe(true);
    expect(persistPreparedApproval).not.toHaveBeenCalled();
  });
  it('completes a parked intent through its existing server action without proposing twice', async () => {
    const prepare = install();
    vi.mocked(findParkedProposalIntent).mockResolvedValueOnce('act_synthetic');
    oneToolCallThenStop('propose_action', { operation: { tool: 'manage_substrate', arguments: { action: 'propose', capability: 'record_learning', payload: { title: 'Synthetic' } } }, reason: 'Keep the source observation.' });
    await collect(runAgentTurn(operatorInput()));
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ operation: expect.objectContaining({ toolName: 'manage_substrate', args: { action: 'approve', action_id: 'act_synthetic' } }) }), expect.anything());
    expect(mockCallMcpTool.mock.calls.some(([, args]) => (args as any)?.action === 'propose')).toBe(false);
  });
  it('preserves denial and read-only checks before preparing anything', async () => {
    const prepare = install();
    oneToolCallThenStop('propose_action', { operation: { tool: 'manage_substrate', arguments: { action: 'approve', action_id: 'act_forged' } }, reason: 'Self approval.' });
    await collect(runAgentTurn(operatorInput()));
    oneToolCallThenStop('propose_action', { operation, reason: 'Obsolete draft.' });
    await collect(runAgentTurn(operatorInput({ readOnly: true })));
    expect(prepare).not.toHaveBeenCalled();
    expect(persistPreparedApproval).not.toHaveBeenCalled();
    expect(mockCallMcpTool.mock.calls.filter(([name, args]) => !(name === 'manage_substrate' && (args as any)?.action === 'get_settings'))).toHaveLength(0);
  });
  it('never creates a deploy gate if the exact snapshot cannot be saved', async () => {
    install();
    const cache = getSharedWorkingTreeCache();
    cache.write('conv-1', 'app_snapshot', 'src/App.tsx', 'export default function App(){return null}');
    oneToolCallThenStop('propose_action', { operation: { tool: 'deploy_frontend', arguments: { app_id: 'app_snapshot' } }, reason: 'Publish this exact source.' });
    const events = await collect(runAgentTurn(operatorInput(), { cache, treeStore: { save: vi.fn(async () => false), load: vi.fn() } as any }));
    expect(persistPreparedApproval).not.toHaveBeenCalled();
    expect(events.some(e => e.type === 'tool_result' && JSON.stringify(e).includes('deploy_tree_unavailable'))).toBe(true);
  });
  it('fails closed if pending lookup or persistence is unavailable', async () => {
    install();
    vi.mocked(persistPreparedApproval).mockRejectedValueOnce(new Error('test lookup failure'));
    oneToolCallThenStop('propose_action', { operation, reason: 'Obsolete draft.' });
    const events = await collect(runAgentTurn(operatorInput()));
    expect(events.some(e => e.type === 'approval_required')).toBe(false);
    expect(events.some(e => e.type === 'tool_result' && JSON.stringify(e).includes('proposal_review_unavailable'))).toBe(true);
  });
  it('recovers dynamic escalation in a foreground Office conversation after a new turn', async () => {
    const prepare = install();
    mockGetConversation.mockResolvedValue({ id: 'conv-1', userId: HUMAN_USER, origin: 'office', organizationId: ORG_ID } as any);
    const args = { action: 'propose', capability: 'revert_action', payload: { action_id: 'act_original' } };
    const input = humanInput({ accessGuard: async () => ({ allowed: true, approvalMode: 'consequential', reason: null }) });
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ action_id: 'act_parked', requires_approval: true }) }] } }));
    oneToolCallThenStop('manage_substrate', args);
    const events = await collect(runAgentTurn(input));
    expect(events.some(e => e.type === 'tool_result' && JSON.stringify(e).includes('parkedProposal'))).toBe(true);
    vi.mocked(findParkedProposalIntent).mockResolvedValueOnce('act_parked');
    oneToolCallThenStop('propose_action', { operation: { tool: 'manage_substrate', arguments: args }, reason: 'Restore the prior record.' });
    await collect(runAgentTurn(input));
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ origin: 'office', operation: expect.objectContaining({ args: { action: 'approve', action_id: 'act_parked' } }) }), expect.anything());
    expect(mockCallMcpTool.mock.calls.filter(([, args]) => (args as any)?.action === 'propose')).toHaveLength(1);
  });
});
