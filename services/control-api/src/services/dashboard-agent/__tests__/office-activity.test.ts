import { describe, expect, it } from 'vitest';
import { createOfficeActivityProjector, projectOfficeConversationActivity } from '../office-activity.js';
const at = '2026-11-01T01:00:00.000Z';
const end = '2026-11-01T01:00:01.250Z';
const call = (id = 'call1', action = 'search_agent_memories') => ({ type: 'tool_call', id, name: 'manage_substrate', args: { action, payload: { body: 'SECRET' }, token: 'SECRET' }, timestamp: at });
const mcp = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
describe('safe Office activity', () => {
  it('updates one identity from running to empty search with measured timestamps', () => {
    const p = createOfficeActivityProjector();
    expect(p.observe(call())).toMatchObject({ id: 'call1', status: 'running', started_at: at });
    const step = p.observe({ type: 'tool_result', id: 'call1', timestamp: end, result: mcp({ items: [], next_cursor: null }) });
    expect(step).toMatchObject({ id: 'call1', status: 'completed', summary: 'No matching memories found', duration_ms: 1250, finished_at: end });
    expect(JSON.stringify(step)).not.toContain('SECRET');
    expect(p.observe({ type: 'tool_result', id: 'call1', result: {} })).toBeNull();
  });
  it.each([false, true])('links only a confirmed native ledger memory result (wrapped %s)', wrapped => {
    const p = createOfficeActivityProjector(); p.observe({ ...call('write', 'propose'), args: { action: 'propose', capability: 'record_agent_memory' } });
    const result = { action_id: 'ledger1', status: 'executed', requires_approval: false, result: { memory_id: 'mem1', revision: 1 } };
    expect(p.observe({ type: 'tool_result', id: 'write', result: wrapped ? mcp(result) : result })).toMatchObject({ status: 'completed', result: { kind: 'agent_memory', id: 'mem1', revision: 1 } });
  });
  it.each([
    [{ requires_approval: true, action_id: 'ledger', result: { memory_id: 'UNSAVED' } }, 'awaiting_approval'],
    [{ status: 'rejected' }, 'denied'], [{ result: { error: 'SECRET' } }, 'failed'],
    [{ content: [{ type: 'text', text: '{"error":"SECRET"}' }] }, 'failed'],
    [{ confirmation_id: 'pending', status: 'pending' }, 'awaiting_approval'],
    [{ result: { memory_id: 'UNCONFIRMED' } }, 'unknown'],
  ])('respects nested and unconfirmed outcomes', (result, status) => {
    const p = createOfficeActivityProjector(); p.observe({ ...call('write', 'propose'), args: { action: 'propose', capability: 'record_agent_memory' } });
    const step = p.observe({ type: 'tool_result', id: 'write', result });
    expect(step?.status).toBe(status); expect(step?.result).toBeUndefined(); expect(JSON.stringify(step)).not.toContain('SECRET');
  });
  it('uses generic labels for unknown tools and never echoes arbitrary arguments', () => {
    const p = createOfficeActivityProjector({ now: () => new Date(at) });
    const step = p.observe({ ...call(), name: 'custom_remote', args: { action: 'send_secret', sql: 'SECRET' } });
    expect(step).toMatchObject({ label: 'Running tool', tool_name: 'custom_remote', started_at: at });
    expect(JSON.stringify(step)).not.toContain('SECRET'); expect(step?.action).toBeUndefined();
  });
  it('bounds malformed, deep, oversized and cyclic envelopes without throwing', () => {
    const cyclic: any = {}; cyclic.result = cyclic;
    for (const result of [cyclic, '{broken', 'x'.repeat(70000), { content: [{ type: 'text', text: 'x'.repeat(70000) }] }, { result: { result: { result: { result: { result: { result: { result: { result: { error: 'SECRET' } } } } } } } } }]) {
      const p = createOfficeActivityProjector(); p.observe(call());
      const step = p.observe({ type: 'tool_result', id: 'call1', result });
      expect(step?.status).toBe('unknown'); expect(JSON.stringify(step).length).toBeLessThan(4096);
    }
  });
  it('groups persisted paired calls after their actual user, preserving unknown timing', () => {
    const row = (id: string, role: string, extra = {}) => ({ id, role, content: '', createdAt: null, ...extra });
    const groups = projectOfficeConversationActivity([
      row('orphan', 'tool', { toolCallId: 'orphan', toolResult: {} }), row('u1', 'user'),
      row('a1', 'assistant', { toolCallId: 'c1', toolName: 'manage_substrate', toolArgs: { action: 'search_agent_memories' } }),
      row('r1', 'tool', { toolCallId: 'c1', toolResult: mcp({ items: [] }) }), row('u2', 'user'),
      row('a2', 'assistant', { toolCallId: 'c2', toolName: 'other', pendingApprovalId: 'approval' }),
    ]);
    expect(groups.map(g => g.user_message_id)).toEqual(['u1', 'u2']);
    expect(groups[0].steps[0]).toMatchObject({ id: 'c1', status: 'completed', started_at: null, duration_ms: null });
    expect(groups[1].steps[0].status).toBe('awaiting_approval');
  });
  it('recognizes the runtime denial receipt without disclosing the reason', () => {
    const p = createOfficeActivityProjector(); p.observe(call());
    expect(p.observe({ type: 'tool_result', id: 'call1', result: { ok: false, error: 'User denied. Reason: SECRET' } })).toMatchObject({ status: 'denied', summary: 'Action denied' });
  });
  it('keeps an explicitly parked proposal awaiting approval', () => {
    const p = createOfficeActivityProjector(); p.observe(call());
    expect(p.observe({ type: 'tool_result', id: 'call1', result: { code: 'proposal_incomplete', parkedProposal: { actionId: 'ledger1', intentFingerprint: 'SECRET' } } })).toMatchObject({ status: 'awaiting_approval' });
  });

  it('recognizes the native Office memory ledger receipt without copying its verdict reason', () => {
    const p = createOfficeActivityProjector(); p.observe({ type: 'tool_call', id: 'native', name: 'manage_office', args: { action: 'record_agent_memory', payload: { title: 'SECRET' } } });
    const step = p.observe({ type: 'tool_result', id: 'native', result: { action_id: 'ledger1', verdict: { result: 'auto_approved', reason: 'SECRET', conflicts: [] }, result: { memory_id: 'mem1', revision: 2 } } });
    expect(step).toMatchObject({ status: 'completed', result: { kind: 'agent_memory', id: 'mem1', revision: 2 } });
    expect(JSON.stringify(step)).not.toContain('SECRET');
  });

  it.each([[{ type: 'done' }, 'unknown'], [{ type: 'blocked', reason: 'execution_interrupted' }, 'interrupted']])('uses terminal runtime evidence for an unfinished call', (event, status) => {
    const p = createOfficeActivityProjector(); p.observe(call());
    expect(p.observe(event)).toMatchObject({ id: 'call1', status, duration_ms: null, finished_at: null });
  });

});
