import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type pg from 'pg';

vi.mock('../loop.js', () => ({ runAgentTurn: vi.fn() }));
vi.mock('../operator-store.js', () => ({
  getOrCreateOperatorConversation: vi.fn(),
  // Passthrough matching today's format. This is intentionally NOT the guard
  // against drift — see the "drift guard" test below, which compares against
  // the real (unmocked) operator-store.js so a future format change in the
  // real module is caught even if this literal is never updated.
  operatorUserId: (orgId: string) => `operator:${orgId}`,
}));
vi.mock('../operator-credential.js', () => ({ getOperatorCredential: vi.fn() }));
vi.mock('../approvals-store.js', () => ({ listPendingByConv: vi.fn() }));
vi.mock('../operator-scratchpad-store.js', () => ({
  getOperatorScratchpad: vi.fn(),
  OPERATOR_SCRATCHPAD_MAX_CHARS: 8000,
}));

import * as loopModule from '../loop.js';
import * as storeModule from '../operator-store.js';
import * as credModule from '../operator-credential.js';
import * as approvalsModule from '../approvals-store.js';
import * as scratchpadModule from '../operator-scratchpad-store.js';
import { runOperatorTurn, OPERATOR_WAKE_PROMPT_VERSION } from '../operator-turn.js';

const mockRunAgentTurn = loopModule.runAgentTurn as MockedFunction<typeof loopModule.runAgentTurn>;
const mockGetConv = storeModule.getOrCreateOperatorConversation as MockedFunction<typeof storeModule.getOrCreateOperatorConversation>;
const mockGetCred = credModule.getOperatorCredential as MockedFunction<typeof credModule.getOperatorCredential>;
const mockListPending = approvalsModule.listPendingByConv as MockedFunction<typeof approvalsModule.listPendingByConv>;
const mockGetScratchpad = scratchpadModule.getOperatorScratchpad as MockedFunction<typeof scratchpadModule.getOperatorScratchpad>;

/** Minimal pending-approval row — only `id` is read by the guard. */
function pendingApproval(id: string) {
  return {
    id,
    conversationId: 'conv-1',
    turnMessageId: 'msg-1',
    toolName: 'manage_substrate',
    toolArgs: { action: 'delete_rule' },
    sensitivity: 'destructive' as const,
    status: 'pending' as const,
    trustScope: null,
    denyReason: null,
    createdAt: 'now',
    resolvedAt: null,
  };
}

const stubPool = {} as pg.Pool;
const job = {
  id: 'job-1', organizationId: 'org-1', name: 'sweep',
  instructions: 'Review the substrate.', intervalSeconds: 600,
};

async function* events(...evts: any[]) { for (const e of evts) yield e; }

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConv.mockResolvedValue('conv-1');
  mockGetCred.mockResolvedValue('bb_sk_test');
  mockListPending.mockResolvedValue([]);
  mockGetScratchpad.mockResolvedValue(null);
});

/**
 * C3 fix round 1. The 'approval' verdict went live with C3, which exposed the
 * C2 wedge from the other side: a pause persists an assistant `tool_calls` row
 * with no tool row answering it, so the NEXT wake would replay that message and
 * then append a new `role:'user'` wake message — the OpenAI-invalid sequence the
 * gateway rejects. One conversation per org, a 1-minute tick, no TTL: the
 * operator would error on every wake until a human clicked. Approval latency is
 * the normal case here, so the wake must be a clean no-op instead.
 */
describe('runOperatorTurn — pending approval blocks the wake', () => {
  it('does not start a turn at all while an approval is unresolved', async () => {
    mockListPending.mockResolvedValue([pendingApproval('appr-pending')]);

    const r = await runOperatorTurn(stubPool, { job, wake: { reason: 'timer' } });

    // The invalid history is never constructed, because the turn never starts.
    // runAgentTurn is what appends the wake `role:'user'` message and calls the
    // gateway, so not calling it covers both.
    expect(mockRunAgentTurn).not.toHaveBeenCalled();

    // Distinguishable from a successful turn AND from an error.
    expect(r.skipped).toEqual({ reason: 'pending_approval', approvalId: 'appr-pending' });
    expect(r.error).toBeNull();
    expect(r.events).toBe(0);
    // NOT reported as a gate: this wake did not create an approval, and the
    // trigger's `gated` counter would double-count the original pause.
    expect(r.approvalId).toBeNull();
    // The conversation id is still reported, so an operator can find the
    // blocked conversation.
    expect(r.conversationId).toBe('conv-1');
  });

  it('checks the OPERATOR conversation, after it has been resolved', async () => {
    mockListPending.mockResolvedValue([pendingApproval('appr-pending')]);

    await runOperatorTurn(stubPool, { job, wake: { reason: 'timer' } });

    expect(mockListPending).toHaveBeenCalledWith(stubPool, 'conv-1');
  });

  it('blocks an EVENT wake too, not just the timer tick', async () => {
    // The check lives in runOperatorTurn precisely because it is the single
    // chokepoint for both wake reasons; a check in the trigger would leave
    // pg_notify-driven wakes wedged.
    mockListPending.mockResolvedValue([pendingApproval('appr-pending')]);

    const r = await runOperatorTurn(stubPool, {
      job,
      wake: { reason: 'event', table: 'entities', rowId: 'row-1' },
    });

    expect(mockRunAgentTurn).not.toHaveBeenCalled();
    expect(r.skipped?.reason).toBe('pending_approval');
  });

  it('runs normally once the approval has been resolved', async () => {
    mockListPending.mockResolvedValue([]);
    mockRunAgentTurn.mockReturnValue(events({ type: 'done' }) as any);

    const r = await runOperatorTurn(stubPool, { job, wake: { reason: 'timer' } });

    expect(mockRunAgentTurn).toHaveBeenCalledTimes(1);
    expect(r.skipped).toBeNull();
    expect(r.error).toBeNull();
  });

  it('reports skipped: null on a normal gating turn (a NEW pause is not a skip)', async () => {
    mockRunAgentTurn.mockReturnValue(events({
      type: 'approval_required', approval_id: 'appr-9',
      tool_name: 'manage_substrate', args: {}, sensitivity: 'destructive',
    }) as any);

    const r = await runOperatorTurn(stubPool, { job, wake: { reason: 'timer' } });

    expect(r.approvalId).toBe('appr-9');
    expect(r.skipped).toBeNull();
  });
});

describe('runOperatorTurn', () => {
  it('runs a turn with the operator credential and no user message from a human', async () => {
    mockRunAgentTurn.mockReturnValue(events({ type: 'assistant_message', content: 'ok' }, { type: 'done' }) as any);

    const r = await runOperatorTurn(stubPool, { job, wake: { reason: 'timer' } });

    expect(r.conversationId).toBe('conv-1');
    expect(r.approvalId).toBeNull();
    expect(r.error).toBeNull();

    const input = mockRunAgentTurn.mock.calls[0][0];
    expect(input.jwt).toBe('bb_sk_test');
    expect(input.organizationId).toBe('org-1');
    expect(input.userId).toBe('operator:org-1');
    expect(input.userMessage).toContain('Review the substrate.');
  });

  it('reports the approval id when the turn gates', async () => {
    mockRunAgentTurn.mockReturnValue(events({
      type: 'approval_required', approval_id: 'appr-9',
      tool_name: 'manage_substrate', args: {}, sensitivity: 'destructive',
    }) as any);

    const r = await runOperatorTurn(stubPool, { job, wake: { reason: 'timer' } });
    expect(r.approvalId).toBe('appr-9');
  });

  it('fails cleanly when the org has no credential', async () => {
    mockGetCred.mockResolvedValue(null);
    const r = await runOperatorTurn(stubPool, { job, wake: { reason: 'timer' } });
    expect(r.error).toContain('no operator credential');
    expect(mockRunAgentTurn).not.toHaveBeenCalled();
  });

  it('mentions the waking event but instructs a re-read', async () => {
    mockRunAgentTurn.mockReturnValue(events({ type: 'done' }) as any);
    await runOperatorTurn(stubPool, {
      job, wake: { reason: 'event', table: 'learnings', rowId: 'lrn_1' },
    });
    const msg = mockRunAgentTurn.mock.calls[0][0].userMessage;
    expect(msg).toContain('learnings');
    expect(msg).toMatch(/re-read|reconcile/i);
  });

  it('sends the identical instructions body for a timer wake and an event wake, differing only in the preamble', async () => {
    mockRunAgentTurn.mockReturnValue(events({ type: 'done' }) as any);
    await runOperatorTurn(stubPool, { job, wake: { reason: 'timer' } });
    const timerMsg = mockRunAgentTurn.mock.calls[0][0].userMessage as string;

    vi.clearAllMocks();
    mockGetConv.mockResolvedValue('conv-1');
    mockGetCred.mockResolvedValue('bb_sk_test');
    mockListPending.mockResolvedValue([]);
    mockGetScratchpad.mockResolvedValue(null);
    mockRunAgentTurn.mockReturnValue(events({ type: 'done' }) as any);
    await runOperatorTurn(stubPool, {
      job, wake: { reason: 'event', table: 'learnings', rowId: 'lrn_1' },
    });
    const eventMsg = mockRunAgentTurn.mock.calls[0][0].userMessage as string;

    // Both must carry the job's instructions verbatim — pg_notify can drop
    // the event entirely, so a timer wake is the only recovery path and must
    // do the same work as an event wake, not a lesser version of it.
    expect(timerMsg).toContain(job.instructions);
    expect(eventMsg).toContain(job.instructions);

    // The wake_reason line inside the header is allowed to differ; everything
    // after the header — the reconcile instruction, the scratchpad block and
    // the job instructions — must be byte-identical between the two reasons.
    const bodyAfterHeader = (m: string) => m.split('=== END OPERATOR WAKE ===')[1];
    expect(bodyAfterHeader(eventMsg)).toBe(bodyAfterHeader(timerMsg));
    expect(bodyAfterHeader(timerMsg)).toBeTruthy();
  });

});

/**
 * The wake envelope. Two DISTINCT surfaces, and keeping them distinct is the
 * point: the header is platform-authored and the agent cannot edit it; the
 * scratchpad is agent-authored. Neither is ever an input to a security
 * decision — see the RULE comment in operator-turn.ts.
 */
async function wakeMessage(wake: any = { reason: 'timer' }): Promise<string> {
  mockRunAgentTurn.mockReturnValue(events({ type: 'done' }) as any);
  await runOperatorTurn(stubPool, { job, wake });
  return mockRunAgentTurn.mock.calls[0][0].userMessage as string;
}

describe('wake header — platform-authored', () => {
  it('carries the organization id', async () => {
    // Before this existed, the org id was passed to runAgentTurn as a
    // parameter and appeared in NOTHING the model could read.
    expect(await wakeMessage()).toContain(`organization_id: ${job.organizationId}`);
  });

  it('carries the job name', async () => {
    expect(await wakeMessage()).toContain(`job: ${job.name}`);
  });

  it('carries the wake reason, for both reasons', async () => {
    expect(await wakeMessage({ reason: 'timer' })).toMatch(/wake_reason: timer/);

    vi.clearAllMocks();
    mockGetConv.mockResolvedValue('conv-1');
    mockGetCred.mockResolvedValue('bb_sk_test');
    mockListPending.mockResolvedValue([]);
    mockGetScratchpad.mockResolvedValue(null);
    const eventMsg = await wakeMessage({ reason: 'event', table: 'learnings', rowId: 'lrn_1' });
    expect(eventMsg).toMatch(/wake_reason: event/);
    expect(eventMsg).toContain('learnings');
    expect(eventMsg).toContain('lrn_1');
  });

  it('carries the prompt version', async () => {
    const msg = await wakeMessage();
    expect(msg).toContain(`prompt_version: ${OPERATOR_WAKE_PROMPT_VERSION}`);
    expect(OPERATOR_WAKE_PROMPT_VERSION).toBeTruthy();
  });

  it('is a clearly delimited block, ahead of the job instructions', async () => {
    const msg = await wakeMessage();
    const open = msg.indexOf('=== OPERATOR WAKE');
    const close = msg.indexOf('=== END OPERATOR WAKE ===');
    expect(open).toBe(0);
    expect(close).toBeGreaterThan(open);
    expect(msg.indexOf(job.instructions)).toBeGreaterThan(close);
  });

  it('still carries the reconcile instruction, on a timer wake', async () => {
    // pg_notify can drop events, so a timer wake is the only recovery path and
    // must do the same work. Load-bearing, not decorative.
    const msg = await wakeMessage({ reason: 'timer' });
    expect(msg).toMatch(/re-read current state and reconcile/i);
  });

  it('still carries the reconcile instruction, on an event wake', async () => {
    const msg = await wakeMessage({ reason: 'event', table: 'entities', rowId: 'e1' });
    expect(msg).toMatch(/re-read current state and reconcile/i);
    expect(msg).toMatch(/hint/i);
  });
});

describe('wake scratchpad — agent-authored', () => {
  it('is read for the job org and included in the message when set', async () => {
    mockGetScratchpad.mockResolvedValue({
      organizationId: 'org-1',
      content: 'Open thread: invoice 42 unpaid since Tuesday.',
      updatedAt: '2026-08-06T00:00:00.000Z',
    });

    const msg = await wakeMessage();

    expect(mockGetScratchpad).toHaveBeenCalledWith(stubPool, job.organizationId);
    expect(msg).toContain('Open thread: invoice 42 unpaid since Tuesday.');
    expect(msg).toContain('--- YOUR SCRATCHPAD (you wrote this) ---');
    expect(msg).toContain('--- END SCRATCHPAD ---');
  });

  it('produces a well-formed message when the org has never written one', async () => {
    mockGetScratchpad.mockResolvedValue(null);

    const msg = await wakeMessage();

    expect(msg).toContain('--- YOUR SCRATCHPAD (you wrote this) ---');
    expect(msg).toContain('--- END SCRATCHPAD ---');
    expect(msg).toMatch(/\(empty/);
    // The rest of the envelope is intact.
    expect(msg).toContain(`organization_id: ${job.organizationId}`);
    expect(msg).toContain(job.instructions);
    expect(msg).not.toContain('undefined');
    expect(msg).not.toContain('null');
  });

  it('treats an all-whitespace scratchpad as empty', async () => {
    mockGetScratchpad.mockResolvedValue({
      organizationId: 'org-1', content: '   \n\n  ', updatedAt: 'now',
    });
    expect(await wakeMessage()).toMatch(/\(empty/);
  });

  it('tells the model substrate is the source of truth and names the update tool', async () => {
    const msg = await wakeMessage();
    expect(msg).toMatch(/source of truth/i);
    expect(msg).toContain('manage_substrate');
    expect(msg).toContain('update_operator_scratchpad');
    expect(msg).toMatch(/rejected, not truncated/i);
    // It carries no authority — the model is told so explicitly.
    expect(msg).toMatch(/no authority/i);
  });

  it('does not fail the wake when the scratchpad read throws', async () => {
    mockGetScratchpad.mockRejectedValue(new Error('db down'));
    mockRunAgentTurn.mockReturnValue(events({ type: 'done' }) as any);

    const r = await runOperatorTurn(stubPool, { job, wake: { reason: 'timer' } });

    expect(r.error).toBeNull();
    expect(mockRunAgentTurn).toHaveBeenCalledTimes(1);
    expect(mockRunAgentTurn.mock.calls[0][0].userMessage).toMatch(/\(empty/);
  });

  it('is not read at all when the wake is a pending-approval no-op', async () => {
    mockListPending.mockResolvedValue([pendingApproval('appr-pending')]);
    await runOperatorTurn(stubPool, { job, wake: { reason: 'timer' } });
    expect(mockGetScratchpad).not.toHaveBeenCalled();
  });
});

describe('runOperatorTurn — misc', () => {
  it('sends the identity operator-store.js actually produces (drift guard)', async () => {
    const real = await vi.importActual<typeof import('../operator-store.js')>('../operator-store.js');

    mockRunAgentTurn.mockReturnValue(events({ type: 'done' }) as any);
    await runOperatorTurn(stubPool, { job, wake: { reason: 'timer' } });

    const input = mockRunAgentTurn.mock.calls[0][0];
    expect(input.userId).toBe(real.operatorUserId(job.organizationId));
  });
});
