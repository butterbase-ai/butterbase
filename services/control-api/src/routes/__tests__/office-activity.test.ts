import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
vi.mock('../../services/dashboard-agent/store.js', () => ({ getConversation: vi.fn(), listMessages: vi.fn(), isOfficeClientConversation: vi.fn().mockResolvedValue(false) }));
vi.mock('../../services/dashboard-agent/loop.js', () => ({ runAgentTurn: vi.fn() }));
import { dashboardAgentRoutes } from '../dashboard-agent.js';
import { getConversation, listMessages } from '../../services/dashboard-agent/store.js';
import { runAgentTurn } from '../../services/dashboard-agent/loop.js';
import { setOperatorAccessPolicy } from '../../services/dashboard-agent/operator-access-policy.js';
const id = '11111111-1111-4111-8111-111111111111', org = '22222222-2222-4222-8222-222222222222';
const rows = [
  { id: 'u1', role: 'user', content: 'Hello', createdAt: new Date('2026-11-01T01:00:00Z') },
  { id: 'c1', role: 'assistant', content: '', toolCallId: 'call1', toolName: 'manage_substrate', toolArgs: { action: 'search_agent_memories', token: 'SECRET' }, createdAt: new Date('2026-11-01T01:00:01Z') },
  { id: 'r1', role: 'tool', content: '', toolCallId: 'call1', toolResult: { items: [], token: 'SECRET' }, createdAt: new Date('2026-11-01T01:00:02Z') },
  { id: 'a1', role: 'assistant', content: 'Hello back', toolArgs: { token: 'SECRET' }, toolResult: { secret: 'SECRET' }, pendingApprovalId: 'PRIVATE', modelUsed: 'PRIVATE', createdAt: new Date('2026-11-01T01:00:03Z') },
];
describe('Office website activity opt in', () => {
  let app: ReturnType<typeof Fastify>;
  let historyRows: any[];
  let historyQuery: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    process.env.DASHBOARD_ASSISTANT_ENABLED = '1';
    historyRows = rows;
    vi.mocked(getConversation).mockResolvedValue({ id, origin: 'office', organizationId: org, userId: 'owner' } as any);
    vi.mocked(listMessages).mockResolvedValue(rows as any);
    vi.mocked(runAgentTurn).mockImplementation(async function* () {
      yield { type: 'tool_call', id: 'call1', name: 'manage_substrate', args: { action: 'search_agent_memories', token: 'SECRET' } };
      yield { type: 'tool_result', id: 'call1', result: { items: [], token: 'SECRET' } };
      yield { type: 'assistant_message', content: 'Hello back' }; yield { type: 'done' };
    });
    setOperatorAccessPolicy({ evaluate: async () => ({ allowed: true, reason: null, approvalMode: 'consequential' }) });
    app = Fastify(); app.decorateRequest('auth', null);
    app.addHook('onRequest', async req => { req.auth = { userId: 'owner', authMethod: 'jwt', scopes: ['*'] }; });
    historyQuery = vi.fn(async (sql: string, values: any[]) => {
      let selected = historyRows;
      if (sql.includes('office_activity_window')) selected = selected.filter(m => ['user','assistant'].includes(m.role)).slice(-values[1]).reverse();
      else if (sql.includes('office_activity_pairs')) {
        let owner = ''; selected = selected.filter(m => { if (m.role === 'user') owner = m.id; return values[1].includes(owner); });
      }
      return { rows: selected.map(m => ({ ...m, created_at: m.createdAt, tool_call_id: m.toolCallId, tool_name: m.toolName, tool_args: m.toolArgs, tool_result: m.toolResult, pending_approval_id: m.pendingApprovalId })) };
    });
    app.decorate('controlDb', { query: historyQuery } as any); await app.register(dashboardAgentRoutes);
  });
  afterEach(async () => { await app.close(); setOperatorAccessPolicy(null); delete process.env.DASHBOARD_ASSISTANT_ENABLED; });
  it('opts into safe prose and activity grouped by actual user', async () => {
    const response = await app.inject({ method: 'GET', url: `/conversations/${id}?activity_version=1`, headers: { 'x-organization-id': org } });
    expect(response.statusCode).toBe(200);
    expect(response.json().messages.map((m: any) => m.id)).toEqual(['u1', 'a1']);
    expect(response.json().activity).toMatchObject([{ user_message_id: 'u1', steps: [{ id: 'call1', status: 'completed', duration_ms: 1000 }] }]);
    expect(response.body).not.toContain('SECRET'); expect(response.body).not.toContain('PRIVATE');
  });
  it('preserves legacy history by default', async () => {
    const response = await app.inject({ method: 'GET', url: `/conversations/${id}`, headers: { 'x-organization-id': org } });
    expect(response.json().messages).toHaveLength(4); expect(response.json().activity).toBeUndefined();
  });
  it('rejects cross-org and missing owner-scoped conversations before transcript reads', async () => {
    for (const header of ['other', org]) {
      if (header === org) vi.mocked(getConversation).mockResolvedValueOnce(null);
      expect((await app.inject({ method: 'GET', url: `/conversations/${id}?activity_version=1`, headers: { 'x-organization-id': header } })).statusCode).toBe(404);
    }
  });
  it.each([undefined, 1])('version %s preserves compatibility and sanitizes opt-in streams', async version => {
    const response = await app.inject({ method: 'POST', url: '/messages', headers: { 'x-organization-id': org }, payload: { conversation_id: id, message: 'Hello', ...(version ? { activity_version: version } : {}) } });
    expect(response.statusCode).toBe(200);
    const events = response.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    expect(events.map(e => e.type)).toEqual(version ? ['activity', 'activity', 'assistant_message', 'done'] : ['tool_call', 'tool_result', 'assistant_message', 'done']);
    if (version) { expect(events[1].step.status).toBe('completed'); expect(response.body).not.toContain('SECRET'); }
  });
  it('rejects unsupported versions', async () => {
    expect((await app.inject({ method: 'POST', url: '/messages', payload: { conversation_id: id, message: 'Hello', activity_version: 2 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/conversations/${id}?activity_version=2`, headers: { 'x-organization-id': org } })).statusCode).toBe(400);
  });
  it('retains assistant prose from a paired call while removing private call metadata', async () => {
    historyRows = rows.map(m => m.id === 'c1' ? { ...m, content: 'Checking that now' } : m);
    const response = await app.inject({ method: 'GET', url: `/conversations/${id}?activity_version=1`, headers: { 'x-organization-id': org } });
    expect(response.json().messages.map((m: any) => m.content)).toEqual(['Hello', 'Checking that now', 'Hello back']);
    expect(response.body).not.toContain('SECRET');
  });

  it('bounds opted-in history at the database read and returns only selected users with complete pairs', async () => {
    const old = Array.from({ length: 120 }, (_, n) => ({ ...rows[0], id: `old${n}` }));
    historyRows = [...old, ...rows];
    const response = await app.inject({ method: 'GET', url: `/conversations/${id}?activity_version=1&limit=3`, headers: { 'x-organization-id': org } });
    expect(response.statusCode).toBe(200);
    expect(response.json().messages.map((m: any) => m.id)).toEqual(['u1', 'a1']);
    expect(response.json().activity.map((g: any) => g.user_message_id)).toEqual(['u1']);
    expect(response.json().activity[0].steps).toMatchObject([{ id: 'call1', status: 'completed' }]);
    expect(historyQuery.mock.calls[0][1]).toEqual([id, 3]);
    expect(historyQuery.mock.calls[1][1][1]).toEqual(['u1']);
    expect(historyQuery.mock.calls[1][1][2]).toBe(128);
  });

  it('exposes a code-only read rejection as failed and never echoes its diagnostic', async () => {
    vi.mocked(runAgentTurn).mockImplementation(async function* () {
      yield { type: 'tool_call', id: 'invalid', name: 'manage_substrate', args: { action: 'search_agent_memories' } };
      yield { type: 'tool_result', id: 'invalid', result: { code: 'agent_memory_request_invalid', message: 'SECRET' } };
      yield { type: 'done' };
    });
    const response = await app.inject({ method: 'POST', url: '/messages', headers: { 'x-organization-id': org }, payload: { conversation_id: id, message: 'Read', activity_version: 1 } });
    const events = response.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    expect(events.filter(e => e.type === 'activity').at(-1)).toMatchObject({ step: { status: 'failed' } });
    expect(response.body).not.toContain('SECRET');
  });
  it('omits detached activity when the latest message-only window has no user anchor', async () => {
    const response = await app.inject({ method: 'GET', url: `/conversations/${id}?activity_version=1&limit=1`, headers: { 'x-organization-id': org } });
    expect(response.json().messages.map((m: any) => m.id)).toEqual(['a1']);
    expect(response.json().activity).toEqual([]); expect(historyQuery).toHaveBeenCalledTimes(1);
  });

});
