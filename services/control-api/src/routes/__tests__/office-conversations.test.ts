/**
 * Task 9 — Office Ask provenance, authority and organization billing.
 *
 * These tests run against the REAL control-plane test database. Provenance is
 * a property of a stored row, and the whole point of the task is that the row
 * — not a request body, not a header, not a flag — decides what a conversation
 * is and which organization pays for it. Mocking the store would let the very
 * bug this task exists to prevent pass.
 *
 * Only the two things that leave the process are mocked:
 *   - `callMcpTool`, so an approved tool does not reach a real MCP server;
 *   - `runAgentTurn`, so an SSE route returns immediately instead of streaming.
 * Everything between them — createConversation, the org listing, ownership,
 * executeOnce, the tool-result row — is real.
 * Prepared target metadata comes from a controlled proposal-provider fixture;
 * argument validation still uses the actual OSS tool registrations.
 *
 * The access policy is the generic OSS seam. The private Office policy is
 * covered by its own tests in cloud/overlays/office; here a controllable stub
 * answers so these tests can pin the PLUMBING (origin reaches the policy,
 * denial survives as denial, owner-only holds).
 */

import { describe, it, expect, vi, beforeEach, afterAll, type MockedFunction } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../services/dashboard-agent/mcp-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/dashboard-agent/mcp-client.js')>(
    '../../services/dashboard-agent/mcp-client.js',
  );
  return { ...actual, callMcpTool: vi.fn() };
});

vi.mock('../../services/dashboard-agent/loop.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/dashboard-agent/loop.js')>(
    '../../services/dashboard-agent/loop.js',
  );
  return {
    ...actual,
    runAgentTurn: vi.fn(async function* () {
      /* ends the SSE stream immediately */
    }),
  };
});

import * as mcpClientModule from '../../services/dashboard-agent/mcp-client.js';
import * as loopModule from '../../services/dashboard-agent/loop.js';
import { dashboardAgentRoutes } from '../dashboard-agent.js';
import {
  createConversation,
  getConversation,
  appendMessage,
} from '../../services/dashboard-agent/store.js';
import { createApproval } from '../../services/dashboard-agent/approvals-store.js';
import { getOrCreateOperatorConversation } from '../../services/dashboard-agent/operator-store.js';
import {
  setOperatorAccessPolicy,
  type OperatorAccessInput,
} from '../../services/dashboard-agent/operator-access-policy.js';
import { captureApprovalOperation, workingTreeArtifact } from '../../services/dashboard-agent/approval-operation.js';
import { getSharedWorkingTreeCache } from '../../services/dashboard-agent/loop.js';
import { PreparedProposalSchema, proposalFingerprint, proposalIntentFingerprint, setApprovalProposalProvider } from '../../services/dashboard-agent/approval-proposal.js';
import { createProposalToolValidator, setProposalToolValidator } from '../../services/dashboard-agent/proposal-validation.js';

const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;
const mockRunAgentTurn = loopModule.runAgentTurn as MockedFunction<typeof loopModule.runAgentTurn>;

const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const OWNER_A = randomUUID();
const MEMBER_A = randomUUID();
const STRANGER = randomUUID();
/** personal_organization_id is NOT NULL and FK'd; every user needs one. */
const PERSONAL = {
  owner: randomUUID(),
  member: randomUUID(),
  stranger: randomUUID(),
};
const PERSONAL_ORG_IDS = Object.values(PERSONAL);
const ALL_ORG_IDS = [ORG_A, ORG_B, ...PERSONAL_ORG_IDS];

/** Per-request caller, read by the test auth hook. */
let actingUser: string = OWNER_A;
let actingAuthMethod = 'jwt';

const POLICY_CALLS: OperatorAccessInput[] = [];
let policyAllowed = true;
let policyReason: string | null = null;
let policyApprovalMode: 'standard' | 'consequential' = 'consequential';

function setPolicy(next: {
  allowed?: boolean;
  reason?: string | null;
  approvalMode?: 'standard' | 'consequential';
}) {
  policyAllowed = next.allowed ?? true;
  policyReason = next.reason ?? null;
  policyApprovalMode = next.approvalMode ?? 'consequential';
}

const appPromise: Promise<FastifyInstance> = (async () => {
  const app = Fastify({ logger: false });
  app.decorateRequest('auth', null as any);
  app.addHook('onRequest', async (request) => {
    (request as any).auth = {
      userId: actingUser,
      authMethod: actingAuthMethod,
      scopes: ['*'],
    };
  });
  app.decorate('controlDb', pool as any);
  await app.register(dashboardAgentRoutes);
  await app.ready();
  return app;
})();

beforeEach(async () => {
  vi.clearAllMocks();
  POLICY_CALLS.length = 0;
  setPolicy({});
  actingUser = OWNER_A;
  actingAuthMethod = 'jwt';
  process.env.DASHBOARD_ASSISTANT_ENABLED = '1';
  mockCallMcpTool.mockResolvedValue({ ok: true, result: { ok: true } });
  setProposalToolValidator(await createProposalToolValidator(() => {}));
  // Target preparation is an adapter seam; ownership, argument validation,
  // immutable operation verification, locking and history remain real.
  setApprovalProposalProvider({
    enabled: () => true,
    prepare: async () => ({ status: 'blocked', code: 'proposal_unreviewable', message: 'Fixture metadata is prepared directly.' }),
    revalidate: async (context, saved) => proposalFingerprint(context.operation) === saved.operationFingerprint
      ? { status: 'valid' } : { status: 'changed', code: 'proposal_state_changed' },
  });

  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = ANY($1::text[])`, [
    [ORG_A, ORG_B],
  ]);
  await pool.query(`DELETE FROM platform_users WHERE id = ANY($1::uuid[])`, [
    [[OWNER_A, MEMBER_A, STRANGER]],
  ]);
  await pool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ALL_ORG_IDS]);

  await pool.query(
    `INSERT INTO organizations (id, name, owner_id, personal) VALUES
       ($1,'Org A',$4,false),
       ($2,'Org B',$5,false),
       ($3,'Personal (owner)',$4,true),
       ($6,'Personal (member)',$5,true),
       ($7,'Personal (stranger)',$8,true)`,
    [ORG_A, ORG_B, PERSONAL.owner, OWNER_A, MEMBER_A, PERSONAL.member, PERSONAL.stranger, STRANGER],
  );
  await pool.query(
    `INSERT INTO platform_users (id, email, personal_organization_id) VALUES
       ($1,'owner-a@test.local',$4),
       ($2,'member-a@test.local',$5),
       ($3,'stranger@test.local',$6)`,
    [OWNER_A, MEMBER_A, STRANGER, PERSONAL.owner, PERSONAL.member, PERSONAL.stranger],
  );
  await pool.query(
    `INSERT INTO organization_members (organization_id, user_id, role) VALUES
       ($1,$2,'owner'), ($1,$3,'member'), ($4,$5,'owner')`,
    [ORG_A, OWNER_A, MEMBER_A, ORG_B, STRANGER],
  );

  setOperatorAccessPolicy({
    async evaluate(input) {
      POLICY_CALLS.push(input);
      return {
        allowed: policyAllowed,
        reason: policyReason,
        approvalMode: policyApprovalMode,
      };
    },
  });
});

afterAll(async () => {
  setOperatorAccessPolicy(null);
  setApprovalProposalProvider(null);
  setProposalToolValidator(null);
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = ANY($1::text[])`, [
    [ORG_A, ORG_B],
  ]);
  await pool.query(`DELETE FROM platform_users WHERE id = ANY($1::uuid[])`, [
    [[OWNER_A, MEMBER_A, STRANGER]],
  ]);
  await pool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ALL_ORG_IDS]);
  await pool.end();
});

function post(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  opts: { org?: string | null; user?: string; authMethod?: string } = {},
) {
  actingUser = opts.user ?? OWNER_A;
  actingAuthMethod = opts.authMethod ?? 'jwt';
  const headers: Record<string, string> = {};
  if (opts.org) headers['x-organization-id'] = opts.org;
  return app.inject({ method: 'POST', url, payload: payload as any, headers });
}

async function createOfficeConversation(userId = MEMBER_A): Promise<string> {
  const conversation = await createConversation(pool, userId, 'Office question', 'claude-sonnet-4-5', {
    origin: 'office',
    organizationId: ORG_A,
  });
  return conversation.id;
}

/** Leave the conversation exactly as a gated turn does. */
async function pauseOnApproval(conversationId: string, authoredBy: string, prepared = true) {
  const messageId = randomUUID();
  const toolCallId = `call_${randomUUID().slice(0, 8)}`;
  const toolArgs = { action: 'update_env', app_id: 'app_1', env: { KEY: 'v' } };
  const operation = captureApprovalOperation({ toolName: 'manage_app', args: toolArgs });
  const proposalDetails = prepared ? PreparedProposalSchema.parse({
    version: 1, source: 'intercepted', preparedAt: new Date().toISOString(),
    operationFingerprint: proposalFingerprint(operation),
    intentFingerprint: proposalIntentFingerprint(operation.toolName, operation.args),
    reason: { text: 'Apply the requested fixture environment setting.', attribution: 'operator' },
    evidence: [],
    preview: {
      title: 'Update the fixture app environment?', summary: 'Set the KEY environment variable.',
      target: { label: 'Fixture app', reference: 'app_1' },
      effects: ['Changes one app environment variable.'], fields: [{ label: 'KEY', value: '[redacted]' }],
    },
    preconditions: [{ kind: 'app', referenceId: 'app_1', fingerprint: proposalFingerprint({ fixture: 'app_1' }) }],
  }) : null;
  const approval = await createApproval(pool, {
    conversationId,
    turnMessageId: messageId,
    toolName: 'manage_app',
    toolArgs,
    sensitivity: 'destructive',
    approvedOperation: operation,
    proposalDetails,
  });
  await appendMessage(
    pool,
    conversationId,
    {
      role: 'assistant',
      content: 'I need to change one setting.',
      toolCallId,
      toolName: 'manage_app',
      toolArgs,
      toolResult: null,
      modelUsed: 'claude-sonnet-4-5',
      pendingApprovalId: approval.id,
    },
    messageId,
  );
  return { approval, toolCallId, authoredBy };
}

describe('creating an Office conversation', () => {
  it('binds the membership-checked organization and marks the row office', async () => {
    const app = await appPromise;
    const res = await post(app, '/conversations', { origin: 'office' }, { org: ORG_A, user: MEMBER_A });

    expect(res.statusCode).toBe(201);
    const conversation = JSON.parse(res.body).conversation;
    expect(conversation.origin).toBe('office');
    expect(conversation.organizationId).toBe(ORG_A);

    const row = await pool.query(
      `SELECT origin, organization_id, user_id FROM dashboard_agent_conversations WHERE id = $1`,
      [conversation.id],
    );
    expect(row.rows[0]).toEqual({ origin: 'office', organization_id: ORG_A, user_id: MEMBER_A });

    // Eligibility is evaluated server-side for the organization, with the
    // asking human as the audit identity — never for the person's personal org.
    expect(POLICY_CALLS).toEqual([
      expect.objectContaining({ organizationId: ORG_A, origin: 'office', actorUserId: MEMBER_A }),
    ]);
  });

  it('refuses a caller who is not a member of the requested organization', async () => {
    const app = await appPromise;
    const res = await post(app, '/conversations', { origin: 'office' }, { org: ORG_A, user: STRANGER });

    expect(res.statusCode).toBe(403);
    expect(POLICY_CALLS).toEqual([]);
    const rows = await pool.query(`SELECT 1 FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG_A]);
    expect(rows.rowCount).toBe(0);
  });

  it('refuses when the organization is not eligible to run an Office', async () => {
    const app = await appPromise;
    setPolicy({ allowed: false, reason: 'paid_plan_required' });
    const res = await post(app, '/conversations', { origin: 'office' }, { org: ORG_A, user: MEMBER_A });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'paid_plan_required' });
    const rows = await pool.query(`SELECT 1 FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG_A]);
    expect(rows.rowCount).toBe(0);
  });

  it('leaves ordinary dashboard creation byte-for-byte unchanged', async () => {
    const app = await appPromise;
    const res = await post(app, '/conversations', {}, { user: MEMBER_A });

    expect(res.statusCode).toBe(201);
    const conversation = JSON.parse(res.body).conversation;
    expect(conversation.origin).toBe('dashboard');
    expect(conversation.organizationId).toBeNull();
    // The dashboard is its own product surface: the Office policy is never
    // consulted, and no organization is bound.
    expect(POLICY_CALLS).toEqual([]);
  });
});

describe('provenance is immutable after creation', () => {
  it('a PATCH body cannot move a conversation to another origin or organization', async () => {
    const app = await appPromise;
    const conversationId = await createOfficeConversation();

    actingUser = MEMBER_A; // the author is the one renaming/re-modelling
    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/${conversationId}`,
      payload: { model: 'claude-sonnet-4-5', origin: 'dashboard', organization_id: ORG_B },
      headers: { 'x-organization-id': ORG_A },
    });

    expect(res.statusCode).toBe(200);
    const row = await pool.query(
      `SELECT origin, organization_id FROM dashboard_agent_conversations WHERE id = $1`,
      [conversationId],
    );
    expect(row.rows[0]).toEqual({ origin: 'office', organization_id: ORG_A });
  });

  it('a message body cannot move a conversation to another origin or organization', async () => {
    const app = await appPromise;
    const conversationId = await createOfficeConversation();

    const res = await post(
      app,
      '/messages',
      { conversation_id: conversationId, message: 'hello', origin: 'dashboard', organization_id: ORG_B },
      { org: ORG_A, user: MEMBER_A },
    );

    expect(res.statusCode).toBe(200);
    const row = await pool.query(
      `SELECT origin, organization_id FROM dashboard_agent_conversations WHERE id = $1`,
      [conversationId],
    );
    expect(row.rows[0]).toEqual({ origin: 'office', organization_id: ORG_A });
    // …and the lie in the body changed nothing about how the turn is governed:
    // the stored row still selects the Office policy and the Office org.
    expect(POLICY_CALLS).toEqual([
      expect.objectContaining({ organizationId: ORG_A, origin: 'office', actorUserId: MEMBER_A }),
    ]);
  });

  it('a duplicate stays Office and stays in its original organization', async () => {
    const app = await appPromise;
    const conversationId = await createOfficeConversation();

    actingUser = MEMBER_A; // the author duplicates their own conversation
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/duplicate`,
      headers: { 'x-organization-id': ORG_A },
    });

    expect(res.statusCode).toBe(201);
    const copy = JSON.parse(res.body).conversation;
    expect(copy.origin).toBe('office');
    expect(copy.organizationId).toBe(ORG_A);
    expect(copy.userId).toBe(MEMBER_A);
  });
});

describe('an Office conversation is reachable only from its organization', () => {
  it('404s a read from a different organization and leaks nothing', async () => {
    const app = await appPromise;
    const conversationId = await createOfficeConversation();

    actingUser = MEMBER_A;
    const res = await app.inject({
      method: 'GET',
      url: `/conversations/${conversationId}`,
      headers: { 'x-organization-id': ORG_B },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'conversation not found' });
  });

  it('404s a turn from a different organization BEFORE any model call', async () => {
    const app = await appPromise;
    const conversationId = await createOfficeConversation();

    const res = await post(
      app,
      '/messages',
      { conversation_id: conversationId, message: 'hello' },
      { org: ORG_B, user: MEMBER_A },
    );

    expect(res.statusCode).toBe(404);
    expect(mockRunAgentTurn).not.toHaveBeenCalled();
  });

  it('refuses a turn before the stream when eligibility has been lost', async () => {
    const app = await appPromise;
    const conversationId = await createOfficeConversation();
    setPolicy({ allowed: false, reason: 'paid_plan_required' });

    const res = await post(
      app,
      '/messages',
      { conversation_id: conversationId, message: 'hello' },
      { org: ORG_A, user: MEMBER_A },
    );

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'paid_plan_required' });
    expect(mockRunAgentTurn).not.toHaveBeenCalled();
  });
});

describe('the organization approval queue includes Office-origin foreground approvals', () => {
  it('lists both sources with a discriminator and no transcript', async () => {
    const app = await appPromise;
    const operatorConversationId = await getOrCreateOperatorConversation(pool, ORG_A, 'claude-sonnet-4-5');
    await pauseOnApproval(operatorConversationId, `operator:${ORG_A}`);

    const officeConversationId = await createOfficeConversation();
    // A marker the response must never contain: chat content is not part of a
    // decision payload.
    await appendMessage(pool, officeConversationId, {
      role: 'user', content: 'SECRET-TRANSCRIPT-MARKER', toolCallId: null, toolName: null,
      toolArgs: null, toolResult: null,
    });
    await pauseOnApproval(officeConversationId, MEMBER_A);

    // Another org's Office approval must not appear.
    const otherOffice = await createConversation(pool, STRANGER, 'Other org', 'claude-sonnet-4-5', {
      origin: 'office',
      organizationId: ORG_B,
    });
    await pauseOnApproval(otherOffice.id, STRANGER);

    actingUser = OWNER_A;
    const res = await app.inject({
      method: 'GET',
      url: '/operator/approvals',
      headers: { 'x-organization-id': ORG_A },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { approvals: Array<{ source: string; conversationId: string }> };
    expect(body.approvals).toHaveLength(2);
    expect(body.approvals.map((a) => a.source).sort()).toEqual(['office', 'operator']);
    expect(body.approvals.find((a) => a.source === 'office')?.conversationId).toBe(officeConversationId);
    expect(res.body).not.toContain('SECRET-TRANSCRIPT-MARKER');
  });

  it('lets a member ask and propose, but only the owner may approve', async () => {
    const app = await appPromise;
    const conversationId = await createOfficeConversation();
    const { approval, toolCallId } = await pauseOnApproval(conversationId, MEMBER_A);

    // A member asks and proposes — creation and the gated turn already proved
    // that above. The decision itself is owner-only.
    const denied = await post(
      app,
      `/operator/approvals/${approval.id}/resolve`,
      { status: 'approved' },
      { org: ORG_A, user: MEMBER_A },
    );
    expect(denied.statusCode).toBe(403);
    expect(mockCallMcpTool).not.toHaveBeenCalled();

    const stillPending = await pool.query(
      `SELECT status FROM dashboard_agent_approvals WHERE id = $1`,
      [approval.id],
    );
    expect(stillPending.rows[0].status).toBe('pending');

    const approved = await post(
      app,
      `/operator/approvals/${approval.id}/resolve`,
      { status: 'approved' },
      { org: ORG_A, user: OWNER_A },
    );
    expect(approved.statusCode).toBe(200);
    const replay = await post(app, `/operator/approvals/${approval.id}/resolve`, { status: 'approved' }, { org: ORG_A, user: OWNER_A });
    expect(replay.statusCode).toBe(409);
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(mockCallMcpTool.mock.calls[0].slice(0, 4)).toEqual([
      'manage_app',
      { action: 'update_env', app_id: 'app_1', env: { KEY: 'v' } },
      expect.any(String),
      ORG_A,
    ]);

    // The author's conversation is preserved and now carries the tool result
    // for the paused call — resolving on someone's behalf does not rewrite
    // who asked.
    const conversation = await getConversation(pool, conversationId, MEMBER_A);
    expect(conversation?.userId).toBe(MEMBER_A);
    const toolRow = await pool.query(
      `SELECT tool_result FROM dashboard_agent_messages
        WHERE conversation_id = $1 AND role = 'tool' AND tool_call_id = $2`,
      [conversationId, toolCallId],
    );
    expect(toolRow.rowCount).toBe(1);
    expect(toolRow.rows[0].tool_result).toEqual({ ok: true });
  });

  it('blocks execution when entitlement is lost but still allows denial', async () => {
    const app = await appPromise;
    const conversationId = await createOfficeConversation();
    const { approval, toolCallId } = await pauseOnApproval(conversationId, MEMBER_A);

    setPolicy({ allowed: false, reason: 'paid_plan_required' });

    const blocked = await post(
      app,
      `/operator/approvals/${approval.id}/resolve`,
      { status: 'approved' },
      { org: ORG_A, user: OWNER_A },
    );
    expect(blocked.statusCode).toBe(409);
    expect(mockCallMcpTool).not.toHaveBeenCalled();

    // Denial must remain possible: that is how an org unwinds old work with no
    // plan, no credits and no current owner.
    const denied = await post(
      app,
      `/operator/approvals/${approval.id}/resolve`,
      { status: 'denied', reason: 'not now' },
      { org: ORG_A, user: OWNER_A },
    );
    expect(denied.statusCode).toBe(200);
    const toolRow = await pool.query(
      `SELECT tool_result FROM dashboard_agent_messages
        WHERE conversation_id = $1 AND role = 'tool' AND tool_call_id = $2`,
      [conversationId, toolCallId],
    );
    expect(toolRow.rowCount).toBe(1);
    expect(toolRow.rows[0].tool_result.error).toMatch(/denied/i);
  });
});

/**
 * The foreground resume route (POST /approvals/:id/resolve) is a second entry
 * point into the same decision. Task 9 requires it to be no weaker than the
 * organization feed: an Office approval is owner-only, and a replay whose
 * artifact moved must be refused rather than shipped.
 */
describe('the foreground resolve route enforces the same Office contract', () => {
  it.each(['/operator/approvals', '/approvals'])('keeps a legacy Office approval pending through %s until it can be reviewed', async (route) => {
    const app = await appPromise;
    const conversationId = await createOfficeConversation(OWNER_A);
    const { approval } = await pauseOnApproval(conversationId, OWNER_A, false);

    const res = await post(app, `${route}/${approval.id}/resolve`, { status: 'approved' }, { org: ORG_A, user: OWNER_A });

    expect(res.statusCode).toBe(409);
    expect(mockCallMcpTool).not.toHaveBeenCalled();
    const row = await pool.query(`SELECT status FROM dashboard_agent_approvals WHERE id = $1`, [approval.id]);
    expect(row.rows[0].status).toBe('pending');
    const effects = await pool.query(`SELECT count(*)::int AS count FROM dashboard_agent_tool_executions WHERE approval_id = $1`, [approval.id]);
    expect(effects.rows[0].count).toBe(0);
  });

  it('refuses a member resolving their own Office approval', async () => {
    const app = await appPromise;
    const conversationId = await createOfficeConversation(MEMBER_A);
    const { approval } = await pauseOnApproval(conversationId, MEMBER_A);

    const res = await post(
      app,
      `/approvals/${approval.id}/resolve`,
      { status: 'approved' },
      { org: ORG_A, user: MEMBER_A },
    );

    expect(res.statusCode).toBe(403);
    expect(mockCallMcpTool).not.toHaveBeenCalled();
    const row = await pool.query(`SELECT status FROM dashboard_agent_approvals WHERE id = $1`, [approval.id]);
    expect(row.rows[0].status).toBe('pending');
  });

  it('lets the owner author approve their own Office approval', async () => {
    const app = await appPromise;
    const conversationId = await createOfficeConversation(OWNER_A);
    const { approval, toolCallId } = await pauseOnApproval(conversationId, OWNER_A);

    const res = await post(
      app,
      `/approvals/${approval.id}/resolve`,
      { status: 'approved' },
      { org: ORG_A, user: OWNER_A },
    );

    expect(res.statusCode).toBe(200);
    const toolRow = await pool.query(
      `SELECT tool_result FROM dashboard_agent_messages
        WHERE conversation_id = $1 AND role = 'tool' AND tool_call_id = $2`,
      [conversationId, toolCallId],
    );
    expect(toolRow.rowCount).toBe(1);
    expect(toolRow.rows[0].tool_result).toEqual({ ok: true });
  });

  it('refuses an owner approve when entitlement has been lost', async () => {
    const app = await appPromise;
    const conversationId = await createOfficeConversation(OWNER_A);
    const { approval } = await pauseOnApproval(conversationId, OWNER_A);
    setPolicy({ allowed: false, reason: 'paid_plan_required' });

    const res = await post(
      app,
      `/approvals/${approval.id}/resolve`,
      { status: 'approved' },
      { org: ORG_A, user: OWNER_A },
    );

    expect(res.statusCode).toBe(409);
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it('refuses a replay whose build artifact changed after the proposal', async () => {
    const app = await appPromise;
    const conversation = await createConversation(pool, OWNER_A, 'Deploy', 'claude-sonnet-4-5', {
      origin: 'office',
      organizationId: ORG_A,
    });
    const cache = getSharedWorkingTreeCache();
    cache.evict(conversation.id, 'app_1');
    cache.write(conversation.id, 'app_1', 'index.html', 'artifact A');
    const artifactA = workingTreeArtifact('app_1', cache.get(conversation.id, 'app_1'))!;
    expect(artifactA).toBeDefined();

    const messageId = randomUUID();
    const toolCallId = `call_${randomUUID().slice(0, 8)}`;
    const toolArgs = { app_id: 'app_1' };
    const approval = await createApproval(pool, {
      conversationId: conversation.id,
      turnMessageId: messageId,
      toolName: 'deploy_frontend',
      toolArgs,
      sensitivity: 'destructive',
      approvedOperation: captureApprovalOperation({
        toolName: 'deploy_frontend',
        args: toolArgs,
        artifact: artifactA,
      }),
    });
    await appendMessage(pool, conversation.id, {
      role: 'assistant',
      content: 'Deploying.',
      toolCallId,
      toolName: 'deploy_frontend',
      toolArgs,
      toolResult: null,
      modelUsed: 'claude-sonnet-4-5',
      pendingApprovalId: approval.id,
    }, messageId);

    // The tree moves before the owner's click.
    cache.write(conversation.id, 'app_1', 'index.html', 'artifact B');
    const fetchMock = vi.fn();
    const prevFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const res = await post(
        app,
        `/approvals/${approval.id}/resolve`,
        { status: 'approved' },
        { org: ORG_A, user: OWNER_A },
      );

      expect(res.statusCode).toBe(409);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockCallMcpTool).not.toHaveBeenCalled();
      const row = await pool.query(`SELECT status FROM dashboard_agent_approvals WHERE id = $1`, [approval.id]);
      expect(row.rows[0].status).toBe('pending');
    } finally {
      global.fetch = prevFetch;
      cache.evict(conversation.id, 'app_1');
    }
  });
});
