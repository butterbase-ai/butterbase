import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type pg from 'pg';

vi.mock('../loop.js', () => ({ runAgentTurn: vi.fn() }));
vi.mock('../operator-store.js', () => ({ getOrCreateOperatorConversation: vi.fn() }));
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
});
