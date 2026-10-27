/**
 * The approval conversation window.
 *
 * The service test runs against the real control-plane database: the point is
 * that the SQL — not a mock — decides which rows a reader receives. The route
 * test keeps a fake pool so it can pin the membership check, limit parsing and
 * 404 without a second fixture.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';

vi.mock('../../services/dashboard-agent/approvals-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/dashboard-agent/approvals-store.js')>()),
  getApprovalForOrg: vi.fn(),
}));

import * as approvalsModule from '../../services/dashboard-agent/approvals-store.js';
import { listApprovalConversation } from '../../services/dashboard-agent/approval-conversation.js';
import { dashboardAgentRoutes } from '../dashboard-agent.js';

const mockGetApproval = approvalsModule.getApprovalForOrg as MockedFunction<
  typeof approvalsModule.getApprovalForOrg
>;

const connectionString = process.env.CONTROL_TEST_DATABASE_URL;
const dbDescribe = connectionString ? describe : describe.skip;

dbDescribe('listApprovalConversation', () => {
  const orgId = randomUUID();
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const afterTurnId = randomUUID();
  const userId = `operator:${orgId}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await pool.query(
      `INSERT INTO dashboard_agent_conversations (id, user_id, title, model, organization_id)
       VALUES ($1, $2, 'Operator', 'synthetic', $3)`,
      [conversationId, userId, orgId],
    );
    const insert = (id: string, role: string, content: string, at: string, extra: {
      toolName?: string; toolCallId?: string;
    } = {}) => pool.query(
      `INSERT INTO dashboard_agent_messages
         (id, conversation_id, role, content, tool_name, tool_call_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, conversationId, role, content, extra.toolName ?? null, extra.toolCallId ?? null, at],
    );
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();

    await insert(userMessageId, 'user', 'Please draft the invoice.', '2026-10-27T10:00:00.000Z');
    await insert(assistantMessageId, 'assistant', 'I will check the thread.', '2026-10-27T10:01:00.000Z');
    await insert(turnId, 'assistant', '', '2026-10-27T10:02:00.000Z', {
      toolName: 'manage_substrate',
      toolCallId: 'call_1',
    });
    await insert(randomUUID(), 'tool', '', '2026-10-27T10:02:30.000Z', {
      toolName: 'manage_substrate',
      toolCallId: 'call_1',
    });
    await insert(randomUUID(), 'user', 'An after-turn message.', '2026-10-27T10:03:00.000Z');
    await insert(afterTurnId, 'assistant', 'An after-turn reply.', '2026-10-27T10:04:00.000Z');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM dashboard_agent_conversations WHERE id=$1', [conversationId]);
    await pool.end();
  });

  it('returns only prose up to the approval turn, in chronological order', async () => {
    const result = await listApprovalConversation(pool, {
      conversationId,
      turnMessageId: turnId,
      approvalCreatedAt: new Date('2026-10-27T10:02:30.000Z'),
      limit: 20,
    });

    expect(result.messages.map((message) => message.content)).toEqual([
      'Please draft the invoice.',
      'I will check the thread.',
    ]);
    expect(result.messages.every((message) => message.role === 'user' || message.role === 'assistant')).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('caps the window and reports truncation', async () => {
    const result = await listApprovalConversation(pool, {
      conversationId,
      turnMessageId: turnId,
      approvalCreatedAt: new Date('2026-10-27T10:02:30.000Z'),
      limit: 1,
    });

    expect(result.messages.map((message) => message.content)).toEqual(['I will check the thread.']);
    expect(result.truncated).toBe(true);
  });

  it('falls back to the approval time when the turn message is missing', async () => {
    const result = await listApprovalConversation(pool, {
      conversationId,
      turnMessageId: randomUUID(),
      approvalCreatedAt: new Date('2026-10-27T10:02:30.000Z'),
      limit: 20,
    });

    expect(result.messages.map((message) => message.content)).toEqual([
      'Please draft the invoice.',
      'I will check the thread.',
    ]);
  });

  it('returns an empty window for a conversation with no prose', async () => {
    const result = await listApprovalConversation(pool, {
      conversationId: randomUUID(),
      turnMessageId: turnId,
      approvalCreatedAt: new Date(),
      limit: 20,
    });

    expect(result).toEqual({ messages: [], truncated: false });
  });
});

describe('GET /operator/approvals/:id/conversation', () => {
  const orgId = '11111111-1111-4111-8111-111111111111';
  let app: FastifyInstance;
  let query: ReturnType<typeof vi.fn>;

  const messageRow = (id: string, role: 'user' | 'assistant', content: string, at: string) => ({
    id,
    role,
    content,
    created_at: new Date(at),
  });

  beforeEach(async () => {
    process.env.DASHBOARD_ASSISTANT_ENABLED = '1';
    mockGetApproval.mockReset();
    query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM organization_members')) {
        return { rows: [{ organization_id: orgId }], rowCount: 1 };
      }
      if (sql.includes('dashboard_agent_messages')) {
        // The SQL returns newest first; the service reverses the window.
        return {
          rows: [
            messageRow('m4', 'user', 'after', '2026-10-27T10:03:00.000Z'),
            messageRow('m2', 'assistant', 'I will check the thread.', '2026-10-27T10:01:00.000Z'),
            messageRow('m1', 'user', 'Please draft the invoice.', '2026-10-27T10:00:00.000Z'),
          ],
          rowCount: 3,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    app = Fastify({ logger: false });
    app.decorateRequest('auth', null as never);
    app.addHook('onRequest', async (request) => {
      (request as never as { auth: unknown }).auth = {
        userId: 'some-user',
        authMethod: 'jwt',
        scopes: ['*'],
      };
    });
    app.decorate('controlDb', { query } as never);
    await app.register(dashboardAgentRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.DASHBOARD_ASSISTANT_ENABLED;
  });

  it('returns the prose window for a member of the approval organization', async () => {
    mockGetApproval.mockResolvedValue({
      id: 'appr-1',
      conversationId: 'conv-1',
      turnMessageId: 'turn-1',
      toolName: 'manage_substrate',
      toolArgs: { action: 'propose' },
      sensitivity: 'destructive',
      status: 'pending',
      trustScope: null,
      denyReason: null,
      createdAt: '2026-10-27T10:02:30.000Z',
      resolvedAt: null,
    } as never);

    const response = await app.inject({
      method: 'GET',
      url: '/operator/approvals/appr-1/conversation',
      headers: { 'x-organization-id': orgId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      messages: [
        { id: 'm1', role: 'user', content: 'Please draft the invoice.', created_at: '2026-10-27T10:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'I will check the thread.', created_at: '2026-10-27T10:01:00.000Z' },
        { id: 'm4', role: 'user', content: 'after', created_at: '2026-10-27T10:03:00.000Z' },
      ],
      truncated: false,
    });
  });

  it('caps the window and reports truncation', async () => {
    mockGetApproval.mockResolvedValue({
      id: 'appr-1', conversationId: 'conv-1', turnMessageId: 'turn-1',
      toolName: 'manage_substrate', toolArgs: {}, sensitivity: 'destructive',
      status: 'pending', trustScope: null, denyReason: null,
      createdAt: '2026-10-27T10:02:30.000Z', resolvedAt: null,
    } as never);

    const response = await app.inject({
      method: 'GET',
      url: '/operator/approvals/appr-1/conversation?limit=1',
      headers: { 'x-organization-id': orgId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      messages: [{ id: 'm4', role: 'user', content: 'after' }],
      truncated: true,
    });
  });

  it('rejects an invalid limit', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/operator/approvals/appr-1/conversation?limit=0',
      headers: { 'x-organization-id': orgId },
    });
    expect(response.statusCode).toBe(400);
  });

  it('404s another organization’s approval', async () => {
    mockGetApproval.mockResolvedValue(null);
    const response = await app.inject({
      method: 'GET',
      url: '/operator/approvals/appr-1/conversation',
      headers: { 'x-organization-id': orgId },
    });
    expect(response.statusCode).toBe(404);
  });
});
