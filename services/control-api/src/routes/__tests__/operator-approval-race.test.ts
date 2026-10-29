/**
 * Resolution serialization keeps one native action and one truthful tool result
 * when approval and denial race. The caller owning the session lock resolves
 * first; the waiter re-reads the terminal status and returns 409 without dispatch.
 * The real database also retains executeOnce cache and transcript assertions.
 */

import { describe, it, expect, vi, beforeEach, afterAll, type MockedFunction } from 'vitest';
import { Pool } from 'pg';

vi.mock('../../services/dashboard-agent/mcp-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/dashboard-agent/mcp-client.js')>(
    '../../services/dashboard-agent/mcp-client.js',
  );
  return { ...actual, callMcpTool: vi.fn() };
});

import * as mcpClientModule from '../../services/dashboard-agent/mcp-client.js';
import { resolveOperatorApproval } from '../dashboard-agent.js';
import { getOrCreateOperatorConversation } from '../../services/dashboard-agent/operator-store.js';
import {
  createSubstrateEscalationApproval,
  getApprovalForOrg,
} from '../../services/dashboard-agent/approvals-store.js';
import { appendMessage, listMessages, type Message } from '../../services/dashboard-agent/store.js';

const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;

const ORG = 'org-approval-race-test';
const ACTION_ID = 'act_01HZX9RACED';
const USER = 'cognito-sub-approver';

const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG]);
  await pool.end();
});

function mcpEnvelope(payload: unknown, isError = false) {
  return { ok: true, result: { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] } };
}

/** What loop.ts leaves behind on a POST-dispatch substrate escalation. */
async function escalate() {
  const conversationId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
  const toolCallId = 'call_propose_race';
  const proposeArgs = { action: 'propose', capability: 'record_decision', payload: { note: 'x' } };

  const assistant = await appendMessage(pool, conversationId, {
    role: 'assistant',
    content: 'Recording that decision.',
    toolCallId,
    toolName: 'manage_substrate',
    toolArgs: proposeArgs,
    toolResult: null,
    modelUsed: 'claude-sonnet-4-5',
  });

  const approval = await createSubstrateEscalationApproval(pool, {
    conversationId,
    pausedMessageId: assistant.id,
    actionId: ACTION_ID,
  });

  return { conversationId, toolCallId, approval: approval! };
}

function toolRow(messages: Message[]): Message | undefined {
  return messages.find((m) => m.role === 'tool');
}

function actionsCalled(): string[] {
  return mockCallMcpTool.mock.calls.map((c) => (c[1] as { action?: string } | undefined)?.action ?? '');
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Substrate's ledger, as far as these tests need it: exactly one transition
 * per action. Whichever of approve/reject lands FIRST wins; the other gets the
 * error `rejectAction`/`approveAction` actually throw.
 */
function substrateLedger(gate: { approve?: Promise<void>; reject?: Promise<void> }) {
  let winner: 'approve' | 'reject' | null = null;
  mockCallMcpTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => {
    const action = args.action as 'approve' | 'reject';
    // The ledger row is claimed on ARRIVAL (substrate takes `FOR UPDATE`
    // first thing); the gate below only delays the response, standing in for a
    // slow execute or a lost reply.
    const won = winner === null;
    if (won) winner = action;
    const wait = action === 'approve' ? gate.approve : gate.reject;
    if (wait) await wait;
    if (won) {
      return mcpEnvelope({
        action_id: ACTION_ID,
        status: action === 'approve' ? 'executed' : 'rejected',
      });
    }
    return mcpEnvelope(
      { error: `action is not in proposed state (status=${winner === 'approve' ? 'executed' : 'rejected'})` },
      true,
    );
  }) as never);
  return { winner: () => winner };
}

/** Poll until `predicate` holds, so the race is sequenced rather than timed. */
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** Give the competing resolver a bounded opportunity to finish before releasing the winner. */
async function softly(predicate: () => boolean) {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('I-1 — a deny racing an approve cannot report a fabricated success', () => {
  it('an approve that owns the lock prevents a racing deny from dispatching', async () => {
    const { conversationId, approval } = await escalate();

    // The approve is held open inside `executeOnce` — it holds the advisory
    // lock for the duration. That is precisely the window in which the old
    // code served the deny out of the approve's cache.
    const approveGate = deferred<void>();
    const ledger = substrateLedger({ approve: approveGate.promise });

    const approvePromise = resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      userId: USER,
      resolution: { status: 'approved' },
    });
    await until(() => actionsCalled().includes('approve'), 'the approve to reach substrate');

    let denyDone = false;
    const denyPromise = resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      userId: USER,
      resolution: { status: 'denied', reason: 'not our call to make' },
    }).then((r) => {
      denyDone = true;
      return r;
    });
    await softly(() => denyDone);
    expect(denyDone).toBe(false);
    expect(actionsCalled()).toEqual(['approve']);

    approveGate.resolve();
    const [denyOutcome, approveOutcome] = await Promise.all([denyPromise, approvePromise]);

    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(actionsCalled()).toEqual(['approve']);
    expect(ledger.winner()).toBe('approve');
    expect(approveOutcome).toEqual({ ok: true });
    expect(denyOutcome).toEqual({ ok: false, code: 409, error: 'approval already approved' });

    const resolved = (await getApprovalForOrg(pool, approval.id, ORG))!;
    expect(resolved.status).toBe('approved');
    expect(resolved.resolvedBy).toBe(USER);
    const messages = await listMessages(pool, conversationId);
    expect(messages.filter(message => message.role === 'tool')).toHaveLength(1);
    expect(JSON.stringify(toolRow(messages)!.toolResult)).toContain('executed');
    expect(JSON.stringify(toolRow(messages)!.toolResult)).not.toContain('substrate_action_rejected');

    // The winning call still executed exactly once, and is the only thing in
    // the idempotency ledger under this approval.
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM dashboard_agent_tool_executions WHERE approval_id = $1`,
      [approval.id],
    );
    expect(rows.rows[0].n).toBe(1);
    const cached = await pool.query<{ result: { result?: { content?: { text: string }[] } } }>(
      `SELECT result FROM dashboard_agent_tool_executions WHERE approval_id = $1`,
      [approval.id],
    );
    expect(cached.rows[0].result.result?.content?.[0].text).toContain('executed');
  });

  it('a deny that owns the lock prevents a racing approve from dispatching', async () => {
    // The mirror image. Under the old code the deny executed first, cached
    // `{ status: "rejected" }` under the approval id, and the approve was
    // handed that envelope — the transcript then said the action was REJECTED
    // on a turn the dashboard recorded as APPROVED.
    const { conversationId, approval } = await escalate();

    const rejectGate = deferred<void>();
    const ledger = substrateLedger({ reject: rejectGate.promise });

    const denyPromise = resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      userId: USER,
      resolution: { status: 'denied', reason: 'no' },
    });
    await until(() => actionsCalled().includes('reject'), 'the deny to reach substrate');

    let approveDone = false;
    const approvePromise = resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      userId: USER,
      resolution: { status: 'approved' },
    }).then((r) => {
      approveDone = true;
      return r;
    });
    await softly(() => approveDone);
    expect(approveDone).toBe(false);
    expect(actionsCalled()).toEqual(['reject']);

    rejectGate.resolve();
    const [approveOutcome, denyOutcome] = await Promise.all([approvePromise, denyPromise]);

    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(actionsCalled()).toEqual(['reject']);
    expect(ledger.winner()).toBe('reject');
    expect(denyOutcome).toEqual({ ok: true });
    expect(approveOutcome).toEqual({ ok: false, code: 409, error: 'approval already denied' });
    const resolved = (await getApprovalForOrg(pool, approval.id, ORG))!;
    expect(resolved.status).toBe('denied');
    expect(resolved.resolvedBy).toBe(USER);

    const messages = await listMessages(pool, conversationId);
    expect(messages.filter(message => message.role === 'tool')).toHaveLength(1);
    const result = toolRow(messages)!.toolResult as Record<string, unknown>;
    expect(result.substrate_action_rejected).toBe(true);
    expect(result.error).toBe('User denied. Reason: no');
    expect(JSON.stringify(result)).not.toContain('executed');
    const rows = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM dashboard_agent_tool_executions WHERE approval_id = $1', [approval.id],
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

describe('I-1 — exactly-once is preserved for the call that does own the key', () => {
  it('serves a RETRIED approve of the same approval from the cache', async () => {
    const { approval } = await escalate();
    substrateLedger({});

    const first = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', userId: USER,
      resolution: { status: 'approved' },
    });
    expect(first).toEqual({ ok: true });

    // A retry 409s at the approval row, so drive `executeOnce` directly to
    // prove the CACHE — not the status guard — is what stops a second call.
    const { executeOnce } = await import('../../services/dashboard-agent/tool-bridge.js');
    const replay = await executeOnce(pool, {
      approvalId: approval.id,
      name: 'manage_substrate',
      args: { action: 'approve', action_id: ACTION_ID },
      jwt: 'jwt-token',
      orgId: ORG,
      principal: 'human',
    });

    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(replay)).toContain('executed');
  });

  it('does not cache a FAILED approve — a transient error stays retryable', async () => {
    const { approval } = await escalate();
    mockCallMcpTool.mockResolvedValue({ ok: false, error: 'substrate unreachable' } as never);

    const first = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', userId: USER,
      resolution: { status: 'approved' },
    });
    expect(first).toEqual({ ok: false, code: 502, error: 'Tool execution failed: substrate unreachable' });

    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM dashboard_agent_tool_executions WHERE approval_id = $1`,
      [approval.id],
    );
    expect(rows.rows[0].n).toBe(0);

    // Still pending, so the retry re-attempts the call rather than replaying.
    expect((await getApprovalForOrg(pool, approval.id, ORG))!.status).toBe('pending');
    mockCallMcpTool.mockResolvedValue(mcpEnvelope({ action_id: ACTION_ID, status: 'executed' }) as never);
    const retry = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', userId: USER,
      resolution: { status: 'approved' },
    });
    expect(retry).toEqual({ ok: true });
    expect(mockCallMcpTool).toHaveBeenCalledTimes(2);
  });
});
