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

import * as loopModule from '../loop.js';
import * as storeModule from '../operator-store.js';
import * as credModule from '../operator-credential.js';
import { runOperatorTurn } from '../operator-turn.js';

const mockRunAgentTurn = loopModule.runAgentTurn as MockedFunction<typeof loopModule.runAgentTurn>;
const mockGetConv = storeModule.getOrCreateOperatorConversation as MockedFunction<typeof storeModule.getOrCreateOperatorConversation>;
const mockGetCred = credModule.getOperatorCredential as MockedFunction<typeof credModule.getOperatorCredential>;

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

    // The preamble (first line) is allowed to differ; everything after it
    // — the reconcile instruction and the job instructions — must be
    // byte-identical between the two wake reasons.
    const timerBody = timerMsg.split('\n').slice(1).join('\n');
    const eventBody = eventMsg.split('\n').slice(1).join('\n');
    expect(eventBody).toBe(timerBody);
  });

  it('sends the identity operator-store.js actually produces (drift guard)', async () => {
    const real = await vi.importActual<typeof import('../operator-store.js')>('../operator-store.js');

    mockRunAgentTurn.mockReturnValue(events({ type: 'done' }) as any);
    await runOperatorTurn(stubPool, { job, wake: { reason: 'timer' } });

    const input = mockRunAgentTurn.mock.calls[0][0];
    expect(input.userId).toBe(real.operatorUserId(job.organizationId));
  });
});
