/**
 * THE RESUME HALF of "the operator keeps working while a decision is pending".
 *
 * A gated operator turn now closes its assistant/tool pair immediately, with a
 * placeholder `role:'tool'` row saying the call is waiting on the owner (see
 * `closeUnansweredToolCall` in store.ts). That row is REAL and it is in the
 * right position, so when the owner finally answers, the resolution must
 * OVERWRITE it — appending a second answer to the same tool_call_id would put a
 * stray `role:'tool'` message at the end of the conversation with no assistant
 * call in front of it, which is the same rejection this whole design exists to
 * avoid, arriving from the other direction.
 *
 * The human assistant never has a placeholder, so it must still take the
 * unchanged append path — pinned below, because "preserve the resume path
 * exactly" is a requirement, not an aspiration.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type pg from 'pg';

vi.mock('../store.js', () => ({
  getMessageByPendingApprovalId: vi.fn(),
  clearPendingApproval: vi.fn(),
  appendMessage: vi.fn(),
  replaceToolResultForCall: vi.fn(),
  stripJsonbNulls: (v: unknown) => v,
}));

vi.mock('../approvals-store.js', () => ({
  getApproval: vi.fn(),
  resolveApproval: vi.fn(),
}));

vi.mock('../mcp-client.js', () => ({ callMcpTool: vi.fn() }));

import * as storeModule from '../store.js';
import * as approvalsModule from '../approvals-store.js';
import { completeApprovalResolution } from '../resume.js';

const mockGetPaused = storeModule.getMessageByPendingApprovalId as MockedFunction<typeof storeModule.getMessageByPendingApprovalId>;
const mockClearPending = storeModule.clearPendingApproval as MockedFunction<typeof storeModule.clearPendingApproval>;
const mockAppend = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockReplace = storeModule.replaceToolResultForCall as MockedFunction<typeof storeModule.replaceToolResultForCall>;
const mockResolveApproval = approvalsModule.resolveApproval as MockedFunction<typeof approvalsModule.resolveApproval>;

const stubPool = {} as pg.Pool;

const approval = {
  id: 'appr-1',
  conversationId: 'conv-1',
  turnMessageId: 'msg-1',
  toolName: 'manage_integrations',
  toolArgs: { to: 'bob@example.com' },
  sensitivity: 'destructive' as const,
  status: 'pending' as const,
  trustScope: null,
  denyReason: null,
  createdAt: 'now',
  resolvedAt: null,
  resolvedBy: null,
  traceId: 'optr_x',
  resumedAt: null,
};

const pausedRow = {
  id: 'msg-1',
  conversationId: 'conv-1',
  role: 'assistant' as const,
  content: '',
  toolCallId: 'call-1',
  toolName: 'manage_integrations',
  toolArgs: { to: 'bob@example.com' },
  toolResult: null,
  modelUsed: 'test/model',
  pendingApprovalId: 'appr-1',
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPaused.mockResolvedValue(pausedRow as never);
  mockResolveApproval.mockResolvedValue({ ...approval, status: 'approved' } as never);
  mockAppend.mockResolvedValue(pausedRow as never);
});

describe('resolution overwrites the "waiting on the owner" placeholder', () => {
  it('replaces the existing tool row in place instead of appending a second answer', async () => {
    mockReplace.mockResolvedValue(true);

    const out = await completeApprovalResolution(stubPool, {
      approval,
      resolution: { status: 'approved' },
      execute: async () => ({ ok: true, result: { sent: true } }) as never,
    });

    expect(out.ok).toBe(true);
    expect(mockReplace).toHaveBeenCalledWith(stubPool, 'conv-1', 'call-1', {
      toolName: 'manage_integrations',
      toolArgs: approval.toolArgs,
      toolResult: { sent: true },
    });
    // The one thing that must NOT happen: a second `role:'tool'` row.
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('replaces in place on the DENY path too', async () => {
    mockReplace.mockResolvedValue(true);
    mockResolveApproval.mockResolvedValue({ ...approval, status: 'denied' } as never);

    await completeApprovalResolution(stubPool, {
      approval,
      resolution: { status: 'denied', reason: 'not now' },
      execute: async () => ({ ok: true, result: {} }) as never,
    });

    expect(mockAppend).not.toHaveBeenCalled();
    const written = mockReplace.mock.calls[0][3].toolResult as { error?: string };
    expect(written.error).toContain('not now');
  });

  it('still clears the pending marker after replacing', async () => {
    mockReplace.mockResolvedValue(true);

    await completeApprovalResolution(stubPool, {
      approval,
      resolution: { status: 'approved' },
      execute: async () => ({ ok: true, result: {} }) as never,
    });

    expect(mockClearPending).toHaveBeenCalledWith(stubPool, 'msg-1');
  });
});

describe('the unchanged path — no placeholder exists', () => {
  it('APPENDS exactly as before for a conversation with no placeholder row', async () => {
    // The human assistant, and every operator approval raised before the
    // placeholder existed. Byte-for-byte the pre-2026-08-08 behaviour.
    mockReplace.mockResolvedValue(false);

    await completeApprovalResolution(stubPool, {
      approval,
      resolution: { status: 'approved' },
      execute: async () => ({ ok: true, result: { sent: true } }) as never,
    });

    expect(mockAppend).toHaveBeenCalledWith(stubPool, 'conv-1', {
      role: 'tool',
      content: '',
      toolCallId: 'call-1',
      toolName: 'manage_integrations',
      toolArgs: approval.toolArgs,
      toolResult: { sent: true },
    });
  });
});

describe('the guards ahead of the write are untouched', () => {
  it('writes nothing when the approval is no longer pending', async () => {
    const out = await completeApprovalResolution(stubPool, {
      approval: { ...approval, status: 'approved' },
      resolution: { status: 'approved' },
      execute: async () => ({ ok: true, result: {} }) as never,
    });

    expect(out).toEqual({ ok: false, code: 409, error: 'approval already approved' });
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('writes nothing when the gated tool call cannot be found', async () => {
    mockGetPaused.mockResolvedValue(null);

    const out = await completeApprovalResolution(stubPool, {
      approval,
      resolution: { status: 'approved' },
      execute: async () => ({ ok: true, result: {} }) as never,
    });

    expect(out.ok).toBe(false);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('leaves the approval pending and writes nothing when execution fails', async () => {
    const out = await completeApprovalResolution(stubPool, {
      approval,
      resolution: { status: 'approved' },
      execute: async () => ({ ok: false, error: 'boom' }) as never,
    });

    expect(out).toEqual({ ok: false, code: 502, error: 'Tool execution failed: boom' });
    expect(mockResolveApproval).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
  });
});
