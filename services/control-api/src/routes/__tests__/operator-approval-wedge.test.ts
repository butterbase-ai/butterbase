/**
 * C2 regression — the permanent per-org operator wedge.
 *
 * When the operator's loop pauses on a gated tool it persists an assistant row
 * carrying a `tool_call_id` with `tool_result: null` and a
 * `pending_approval_id`, and terminates the turn. The AI gateway REJECTS any
 * conversation history that ends with an assistant `tool_calls` message and no
 * matching tool result (see resume.ts's header).
 *
 * `resolveOperatorApproval` used to flip the approval row and stop, on the
 * assumption that "the operator's loop picks the resolution up". It cannot.
 * And because there is exactly ONE operator conversation per org, reused
 * forever, the FIRST resolved gate left that org's operator sending an invalid
 * message sequence on every wake — every ten minutes, permanently, with no
 * rotation and no recovery short of hand-editing the database.
 *
 * These tests assert the property the gateway actually enforces: after a
 * resolution, EVERY assistant row with a tool_call_id has a matching
 * `role: 'tool'` row, and no pending_approval_id is left behind. They fail
 * against the pre-fix implementation on both the approve and the deny path.
 *
 * Only mcp-client is mocked — executeOnce, the advisory lock, the approvals
 * store and the message store all run against the real control-plane DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll, type MockedFunction } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

vi.mock('../../services/dashboard-agent/mcp-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/dashboard-agent/mcp-client.js')>(
    '../../services/dashboard-agent/mcp-client.js',
  );
  return { ...actual, callMcpTool: vi.fn() };
});

/**
 * Deploy approvals now execute from the persisted snapshot, not the
 * process-local cache — that is the fix for cross-instance resolves. These
 * tests run against the real DB but must not require a live Redis, so the
 * shared store is an in-memory Map owned by this file. Each deploy test seeds
 * the same tree it writes to the working-tree cache.
 */
const { deployTreeSnapshots } = vi.hoisted(() => ({
  deployTreeSnapshots: new Map<string, unknown>(),
}));

vi.mock('../../services/dashboard-agent/deploy-tree-store.js', () => ({
  getSharedDeployTreeStore: () => ({
    save: async (approvalId: string, tree?: Map<string, unknown>) => {
      if (!tree || tree.size === 0) return false;
      deployTreeSnapshots.set(approvalId, tree);
      return true;
    },
    load: async (approvalId: string) => deployTreeSnapshots.get(approvalId) ?? null,
  }),
  createDeployTreeStore: vi.fn(),
}));

import * as mcpClientModule from '../../services/dashboard-agent/mcp-client.js';
import { resolveOperatorApproval } from '../dashboard-agent.js';
import { getOrCreateOperatorConversation } from '../../services/dashboard-agent/operator-store.js';
import { createApproval, getApprovalForOrg } from '../../services/dashboard-agent/approvals-store.js';
import { appendMessage, listMessages, type Message } from '../../services/dashboard-agent/store.js';
import { setOperatorAccessPolicy } from '../../services/dashboard-agent/operator-access-policy.js';
import {
  captureApprovalOperation,
  functionSourceArtifact,
  workingTreeArtifact,
} from '../../services/dashboard-agent/approval-operation.js';
import { getSharedWorkingTreeCache } from '../../services/dashboard-agent/loop.js';
import { getSharedDeployTreeStore } from '../../services/dashboard-agent/deploy-tree-store.js';

const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;

const ORG = 'org-wedge-test';
const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

beforeEach(async () => {
  vi.clearAllMocks();
  deployTreeSnapshots.clear();
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG]);
  await pool.end();
});

/**
 * Reproduce exactly what loop.ts leaves behind when it gates a tool call:
 * a pre-generated message id, an approval referencing it, then the assistant
 * tool-call row carrying pending_approval_id and no result.
 */
async function pauseOnGatedTool(toolArgs: unknown = { action: 'propose', capability: 'delete_entity' }) {
  const conversationId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
  const messageId = randomUUID();
  const toolCallId = `call_${randomUUID().slice(0, 8)}`;

  const approval = await createApproval(pool, {
    conversationId,
    turnMessageId: messageId,
    toolName: 'manage_substrate',
    toolArgs,
    sensitivity: 'destructive',
  });

  await appendMessage(
    pool,
    conversationId,
    {
      role: 'assistant',
      content: 'I need to delete that entity.',
      toolCallId,
      toolName: 'manage_substrate',
      toolArgs,
      toolResult: null,
      modelUsed: 'claude-sonnet-4-5',
      pendingApprovalId: approval.id,
    },
    messageId,
  );

  return { conversationId, approval, toolCallId };
}

/**
 * The gateway's actual precondition, as a predicate over persisted history:
 * every assistant row that carries a tool_call_id must be answered by a
 * `role: 'tool'` row with the same id.
 */
function unansweredToolCalls(messages: Message[]): string[] {
  const answered = new Set(
    messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId as string),
  );
  return messages
    .filter((m) => m.role === 'assistant' && m.toolCallId && !answered.has(m.toolCallId))
    .map((m) => m.toolCallId as string);
}

describe('C2 — resolving an operator approval leaves a VALID conversation history', () => {
  it('approve: writes the matching role:tool row and clears pending_approval_id', async () => {
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool();
    mockCallMcpTool.mockResolvedValue({ ok: true, result: { action_id: 'act_1', status: 'executed' } });

    // Pre-state: the history is invalid — this is the wedge.
    expect(unansweredToolCalls(await listMessages(pool, conversationId))).toEqual([toolCallId]);

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome).toEqual({ ok: true });

    const messages = await listMessages(pool, conversationId);

    // 1. The history the next wake will replay is valid.
    expect(unansweredToolCalls(messages)).toEqual([]);

    // 2. The tool row carries the executed result under the matching id.
    const toolRow = messages.find((m) => m.role === 'tool')!;
    expect(toolRow).toBeDefined();
    expect(toolRow.toolCallId).toBe(toolCallId);
    expect(toolRow.toolName).toBe('manage_substrate');
    // The tool RESULT, unwrapped from the McpCallResult envelope — the same
    // shape resume.ts persists for the human assistant.
    expect(toolRow.toolResult).toEqual({ action_id: 'act_1', status: 'executed' });

    // 3. No pending marker survives.
    expect(messages.every((m) => m.pendingApprovalId === null)).toBe(true);

    // 4. The approval itself is resolved.
    expect((await getApprovalForOrg(pool, approval.id, ORG))!.status).toBe('approved');

    // 5. The tool actually ran, exactly once.
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });

  it('deny: ALSO writes the matching role:tool row and clears pending_approval_id', async () => {
    // The deny path is the one that reached the wedge in production: it skipped
    // execution and wrote nothing at all, so the conversation stayed invalid.
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool();

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'denied', reason: 'not this customer' },
    });
    expect(outcome).toEqual({ ok: true });

    const messages = await listMessages(pool, conversationId);
    expect(unansweredToolCalls(messages)).toEqual([]);

    const toolRow = messages.find((m) => m.role === 'tool')!;
    expect(toolRow.toolCallId).toBe(toolCallId);
    // The denial is a tool RESULT the model has to see, not an absence.
    expect(toolRow.toolResult).toEqual({ ok: false, error: 'User denied. Reason: not this customer' });

    expect(messages.every((m) => m.pendingApprovalId === null)).toBe(true);

    const resolved = (await getApprovalForOrg(pool, approval.id, ORG))!;
    expect(resolved.status).toBe('denied');
    expect(resolved.denyReason).toBe('not this customer');

    // Denial must never execute the tool.
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it('a failed execution leaves the approval pending and writes NOTHING (retryable, not wedged)', async () => {
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool();
    mockCallMcpTool.mockResolvedValue({ ok: false, error: 'mcp timeout' });

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as { code: number }).code).toBe(502);

    // Still pending, still marked, no orphaned tool row: the human can retry.
    expect((await getApprovalForOrg(pool, approval.id, ORG))!.status).toBe('pending');
    const messages = await listMessages(pool, conversationId);
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(0);
    expect(messages.find((m) => m.toolCallId === toolCallId)!.pendingApprovalId).toBe(approval.id);
  });

  it('a retried approve replays the cached result and fires the tool once', async () => {
    const { conversationId, approval } = await pauseOnGatedTool();
    mockCallMcpTool.mockResolvedValue({ ok: true, result: { action_id: 'act_1' } });

    const first = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', resolution: { status: 'approved' },
    });
    const second = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', resolution: { status: 'approved' },
    });

    expect(first).toEqual({ ok: true });
    // Second is refused by the status guard — but the important part is that
    // the tool did not fire twice and the history did not gain a second row.
    expect(second.ok).toBe(false);
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect((await listMessages(pool, conversationId)).filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('404s (and writes nothing) for an approval outside the caller org', async () => {
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool();

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: 'org-somebody-else',
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome).toEqual({ ok: false, code: 404, error: 'approval not found' });

    const messages = await listMessages(pool, conversationId);
    expect(unansweredToolCalls(messages)).toEqual([toolCallId]);
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it('the bridge executes as a HUMAN principal, so substrate approve is not blocked', async () => {
    // The operator policy table denies manage_substrate `approve` to the
    // OPERATOR (it could otherwise approve its own gated proposal and forge an
    // approved_by_kind='human' audit row). The approval bridge calls the same
    // action on a person's behalf and must not be caught by that denial.
    const { approval } = await pauseOnGatedTool({ action: 'approve', action_id: 'act_1' });
    mockCallMcpTool.mockResolvedValue({ ok: true, result: { status: 'executed' } });

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', resolution: { status: 'approved' },
    });

    expect(outcome).toEqual({ ok: true });
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });

  it('a non-allowlisted tool is still refused, even for a human principal', async () => {
    const conversationId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
    const messageId = randomUUID();
    const approval = await createApproval(pool, {
      conversationId,
      turnMessageId: messageId,
      // `manage_frontend` is absent from the operator tool TABLE entirely, so
      // `principalMayExecute('human', …)` refuses it. `manage_billing` — the
      // tool this test used before 2026-08-07 — is ON the surface at the
      // approval tier now, so it is legitimately executable by a human
      // principal and no longer demonstrates the guard.
      toolName: 'manage_frontend',
      toolArgs: { action: 'delete', app_id: 'app-1' },
      sensitivity: 'destructive',
    });
    await appendMessage(
      pool, conversationId,
      {
        role: 'assistant', content: '', toolCallId: 'call_billing',
        toolName: 'manage_frontend', toolArgs: { action: 'delete', app_id: 'app-1' }, toolResult: null,
        modelUsed: 'claude-sonnet-4-5', pendingApprovalId: approval.id,
      },
      messageId,
    );

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', resolution: { status: 'approved' },
    });

    expect(outcome.ok).toBe(false);
    expect((outcome as { code: number }).code).toBe(502);
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task 8 — Office consequential approvals
// ---------------------------------------------------------------------------

/**
 * A real org with an owner and a member. `organization_members` has FKs to
 * `organizations` and `platform_users`, and `platform_users.personal_organization_id`
 * is NOT NULL, so the fixture creates the org first (its `owner_id` has no FK),
 * then the users pointing at it, then the memberships.
 */
async function seedOrgWithOwnerAndMember(): Promise<{ orgId: string; ownerId: string; memberId: string }> {
  const orgId = randomUUID();
  const ownerId = randomUUID();
  const memberId = randomUUID();

  await pool.query(
    `INSERT INTO organizations
       (id, name, owner_id, personal, credits_usd, auto_refill_enabled,
        account_status, monthly_allowance_usd, special_pricing)
     VALUES ($1, 'Wedge Office Test', $2, false, 0, false, 'active', 0, false)`,
    [orgId, ownerId],
  );
  await pool.query(
    `INSERT INTO platform_users (id, email, personal_organization_id)
     VALUES ($1, $2, $3), ($4, $5, $3)`,
    [ownerId, `${ownerId}@wedge.test`, orgId, memberId, `${memberId}@wedge.test`],
  );
  await pool.query(
    `INSERT INTO organization_members (organization_id, user_id, role, joined_at)
     VALUES ($1, $2, 'owner', NOW()), ($1, $3, 'member', NOW())`,
    [orgId, ownerId, memberId],
  );
  return { orgId, ownerId, memberId };
}

async function dropOrg(orgId: string): Promise<void> {
  await pool.query(`DELETE FROM organization_members WHERE organization_id = $1`, [orgId]);
  await pool.query(`DELETE FROM platform_users WHERE personal_organization_id = $1`, [orgId]);
  await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
}

async function seedConsequentialApproval(input: {
  orgId: string;
  approvedOperation?: unknown;
  toolName?: string;
  toolArgs?: unknown;
}) {
  const conversationId = await getOrCreateOperatorConversation(pool, input.orgId, 'claude-sonnet-4-5');
  const messageId = randomUUID();
  const toolName = input.toolName ?? 'insert_row';
  const toolArgs = input.toolArgs ?? { app_id: 'app-1', table: 'tickets', data: { status: 'done' } };
  const approval = await createApproval(pool, {
    conversationId,
    turnMessageId: messageId,
    toolName,
    toolArgs,
    sensitivity: 'destructive',
    approvedOperation: (input.approvedOperation ?? null) as never,
  });
  await appendMessage(
    pool, conversationId,
    {
      role: 'assistant', content: '', toolCallId: `call_${randomUUID().slice(0, 8)}`,
      toolName, toolArgs, toolResult: null,
      modelUsed: 'claude-sonnet-4-5', pendingApprovalId: approval.id,
    },
    messageId,
  );
  return { conversationId, approval };
}

describe('Task 8 — Office consequential approval authorization', () => {
  afterEach(() => {
    setOperatorAccessPolicy(null);
  });

  it('a member cannot approve; the owner can', async () => {
    const { orgId, ownerId, memberId } = await seedOrgWithOwnerAndMember();
    try {
      setOperatorAccessPolicy({
        evaluate: async () => ({ allowed: true, reason: null, approvalMode: 'consequential' }),
      });
      mockCallMcpTool.mockResolvedValue({ ok: true, result: { ok: true } });
      const { approval } = await seedConsequentialApproval({
        orgId,
        approvedOperation: captureApprovalOperation({
          toolName: 'insert_row',
          args: { app_id: 'app-1', table: 'tickets', data: { status: 'done' } },
        }),
      });

      const asMember = await resolveOperatorApproval(pool, {
        approvalId: approval.id,
        orgId,
        jwt: 'member-jwt',
        userId: memberId,
        authMethod: 'jwt',
        resolution: { status: 'approved' },
      });
      expect(asMember).toMatchObject({ ok: false, code: 403 });
      expect(mockCallMcpTool).not.toHaveBeenCalled();

      const asOwner = await resolveOperatorApproval(pool, {
        approvalId: approval.id,
        orgId,
        jwt: 'owner-jwt',
        userId: ownerId,
        authMethod: 'jwt',
        resolution: { status: 'approved' },
      });
      expect(asOwner).toEqual({ ok: true });
      expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
      expect((await getApprovalForOrg(pool, approval.id, orgId))!.status).toBe('approved');
    } finally {
      await dropOrg(orgId);
    }
  });

  it('a service/API key cannot approve a consequential action', async () => {
    const { orgId, ownerId } = await seedOrgWithOwnerAndMember();
    try {
      setOperatorAccessPolicy({
        evaluate: async () => ({ allowed: true, reason: null, approvalMode: 'consequential' }),
      });
      const { approval } = await seedConsequentialApproval({
        orgId,
        approvedOperation: captureApprovalOperation({ toolName: 'insert_row', args: { app_id: 'app-1' } }),
      });

      const outcome = await resolveOperatorApproval(pool, {
        approvalId: approval.id,
        orgId,
        jwt: 'bb_sk_service',
        userId: ownerId,
        authMethod: 'api_key',
        resolution: { status: 'approved' },
      });

      expect(outcome).toMatchObject({ ok: false, code: 403 });
      expect(mockCallMcpTool).not.toHaveBeenCalled();
    } finally {
      await dropOrg(orgId);
    }
  });

  it('downgraded entitlement blocks approve but a denial still completes', async () => {
    const { orgId, ownerId } = await seedOrgWithOwnerAndMember();
    try {
      setOperatorAccessPolicy({
        evaluate: async () => ({ allowed: false, reason: 'paid_plan_required', approvalMode: 'consequential' }),
      });
      const { approval } = await seedConsequentialApproval({
        orgId,
        approvedOperation: captureApprovalOperation({ toolName: 'insert_row', args: { app_id: 'app-1' } }),
      });

      const approve = await resolveOperatorApproval(pool, {
        approvalId: approval.id,
        orgId,
        jwt: 'owner-jwt',
        userId: ownerId,
        authMethod: 'jwt',
        resolution: { status: 'approved' },
      });
      expect(approve).toMatchObject({ ok: false, code: 409, error: 'paid_plan_required' });
      expect(mockCallMcpTool).not.toHaveBeenCalled();
      // Still pending — the owner can decide the other way.
      expect((await getApprovalForOrg(pool, approval.id, orgId))!.status).toBe('pending');

      const deny = await resolveOperatorApproval(pool, {
        approvalId: approval.id,
        orgId,
        jwt: 'owner-jwt',
        userId: ownerId,
        authMethod: 'jwt',
        resolution: { status: 'denied', reason: 'not any more' },
      });
      expect(deny).toEqual({ ok: true });
      expect(mockCallMcpTool).not.toHaveBeenCalled();
      expect((await getApprovalForOrg(pool, approval.id, orgId))!.status).toBe('denied');
    } finally {
      await dropOrg(orgId);
    }
  });

  it('a legacy consequential approval with no recorded operation must be re-proposed', async () => {
    const { orgId, ownerId } = await seedOrgWithOwnerAndMember();
    try {
      setOperatorAccessPolicy({
        evaluate: async () => ({ allowed: true, reason: null, approvalMode: 'consequential' }),
      });
      const { approval } = await seedConsequentialApproval({ orgId });

      const outcome = await resolveOperatorApproval(pool, {
        approvalId: approval.id,
        orgId,
        jwt: 'owner-jwt',
        userId: ownerId,
        authMethod: 'jwt',
        resolution: { status: 'approved' },
      });

      expect(outcome).toMatchObject({ ok: false, code: 409 });
      expect((outcome as { error: string }).error).toContain('approval_operation_missing');
      expect(mockCallMcpTool).not.toHaveBeenCalled();
    } finally {
      await dropOrg(orgId);
    }
  });

  it('a STANDARD (non-Office) approval keeps its existing behavior: membership-only', async () => {
    // No policy registered => evaluateOperatorAccess answers 'standard'.
    const { orgId, memberId } = await seedOrgWithOwnerAndMember();
    try {
      mockCallMcpTool.mockResolvedValue({ ok: true, result: { ok: true } });
      const { approval } = await seedConsequentialApproval({ orgId });

      const outcome = await resolveOperatorApproval(pool, {
        approvalId: approval.id,
        orgId,
        jwt: 'member-jwt',
        userId: memberId,
        authMethod: 'jwt',
        resolution: { status: 'approved' },
      });

      expect(outcome).toEqual({ ok: true });
      expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    } finally {
      await dropOrg(orgId);
    }
  });

  it('a changed working-tree artifact refuses the execution (never substitutes B)', async () => {
    const { orgId, ownerId } = await seedOrgWithOwnerAndMember();
    const cache = getSharedWorkingTreeCache();
    const conversationId = await getOrCreateOperatorConversation(pool, orgId, 'claude-sonnet-4-5');
    try {
      setOperatorAccessPolicy({
        evaluate: async () => ({ allowed: true, reason: null, approvalMode: 'consequential' }),
      });
      cache.write(conversationId, 'app-1', 'src/App.tsx', 'artifact A');
      const messageId = randomUUID();
      const toolArgs = { app_id: 'app-1' };
      const opA = captureApprovalOperation({
        toolName: 'deploy_frontend',
        args: toolArgs,
        artifact: {
          kind: 'inline_code',
          referenceId: 'app-1',
          // A digest that cannot match what the tree actually builds.
          sha256: 'a'.repeat(64),
        },
      });
      const approval = await createApproval(pool, {
        conversationId,
        turnMessageId: messageId,
        toolName: 'deploy_frontend',
        toolArgs,
        sensitivity: 'destructive',
        approvedOperation: opA,
      });
      // Execution reads the persisted snapshot, not the live cache.
      await getSharedDeployTreeStore().save(approval.id, cache.get(conversationId, 'app-1')!);
      await appendMessage(
        pool, conversationId,
        {
          role: 'assistant', content: '', toolCallId: 'call_deploy',
          toolName: 'deploy_frontend', toolArgs, toolResult: null,
          modelUsed: 'claude-sonnet-4-5', pendingApprovalId: approval.id,
        },
        messageId,
      );

      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      const outcome = await resolveOperatorApproval(pool, {
        approvalId: approval.id,
        orgId,
        jwt: 'owner-jwt',
        userId: ownerId,
        authMethod: 'jwt',
        resolution: { status: 'approved' },
      });

      expect(outcome).toMatchObject({ ok: false, code: 409 });
      expect((outcome as { error: string }).error).toContain('approval_operation_changed');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockCallMcpTool).not.toHaveBeenCalled();
      // Still pending, so the owner can re-propose or deny.
      expect((await getApprovalForOrg(pool, approval.id, orgId))!.status).toBe('pending');
    } finally {
      cache.evict(conversationId, 'app-1');
      await pool.query(`DELETE FROM dashboard_agent_conversations WHERE id = $1`, [conversationId]);
      await dropOrg(orgId);
    }
  });

  it('an UNCHANGED approve replays the recorded FRONTEND deploy through the HTTP transport', async () => {
    const { orgId, ownerId } = await seedOrgWithOwnerAndMember();
    const cache = getSharedWorkingTreeCache();
    const conversationId = await getOrCreateOperatorConversation(pool, orgId, 'claude-sonnet-4-5');
    const prevApiUrl = process.env.CONTROL_API_URL;
    const prevFetch = global.fetch;
    try {
      process.env.CONTROL_API_URL = 'http://api.test';
      setOperatorAccessPolicy({
        evaluate: async () => ({ allowed: true, reason: null, approvalMode: 'consequential' }),
      });
      cache.write(conversationId, 'app-1', 'src/App.tsx', 'artifact A');
      const artifact = workingTreeArtifact('app-1', cache.get(conversationId, 'app-1'));
      const toolArgs = { app_id: 'app-1' };
      const approval = await createApproval(pool, {
        conversationId,
        turnMessageId: randomUUID(),
        toolName: 'deploy_frontend',
        toolArgs,
        sensitivity: 'destructive',
        approvedOperation: captureApprovalOperation({ toolName: 'deploy_frontend', args: toolArgs, artifact }),
      });
      await getSharedDeployTreeStore().save(approval.id, cache.get(conversationId, 'app-1')!);
      await appendMessage(
        pool, conversationId,
        {
          role: 'assistant', content: '', toolCallId: 'call_deploy_ok',
          toolName: 'deploy_frontend', toolArgs, toolResult: null,
          modelUsed: 'claude-sonnet-4-5', pendingApprovalId: approval.id,
        },
        randomUUID(),
      );

      const calls: string[] = [];
      const json = (body: unknown) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
      });
      global.fetch = vi.fn(async (url: unknown, init?: { method?: string }) => {
        const u = String(url);
        const m = init?.method ?? 'GET';
        calls.push(`${m} ${u}`);
        if (u === 'http://api.test/v1/app-1/frontend/deployments/from-source') {
          return json({ deployment_id: 'dep_1', upload_url: 'https://r2.test/put' });
        }
        if (u === 'https://r2.test/put') return { ok: true, status: 200, text: async () => 'ok' };
        if (u === 'http://api.test/v1/app-1/frontend/deployments/from-source/dep_1/start') {
          return json({ ok: true });
        }
        if (u === 'http://api.test/v1/app-1/frontend/deployments') {
          return json({ deployments: [{ id: 'dep_1', status: 'READY', url: 'https://app.test' }] });
        }
        throw new Error(`unexpected fetch: ${m} ${u}`);
      }) as unknown as typeof fetch;

      const outcome = await resolveOperatorApproval(pool, {
        approvalId: approval.id,
        orgId,
        jwt: 'owner-jwt',
        userId: ownerId,
        authMethod: 'jwt',
        resolution: { status: 'approved' },
      });

      expect(outcome).toEqual({ ok: true });
      expect(calls).toEqual(expect.arrayContaining([
        'POST http://api.test/v1/app-1/frontend/deployments/from-source',
        'PUT https://r2.test/put',
        'POST http://api.test/v1/app-1/frontend/deployments/from-source/dep_1/start',
        'GET http://api.test/v1/app-1/frontend/deployments',
      ]));
      expect((await getApprovalForOrg(pool, approval.id, orgId))!.status).toBe('approved');
    } finally {
      process.env.CONTROL_API_URL = prevApiUrl;
      if (prevApiUrl === undefined) delete process.env.CONTROL_API_URL;
      global.fetch = prevFetch;
      cache.evict(conversationId, 'app-1');
      await pool.query(`DELETE FROM dashboard_agent_conversations WHERE id = $1`, [conversationId]);
      await dropOrg(orgId);
    }
  }, 30_000);

  it('an UNCHANGED approve replays the recorded FUNCTION deploy through the HTTP transport', async () => {
    const { orgId, ownerId } = await seedOrgWithOwnerAndMember();
    const cache = getSharedWorkingTreeCache();
    const conversationId = await getOrCreateOperatorConversation(pool, orgId, 'claude-sonnet-4-5');
    const prevApiUrl = process.env.CONTROL_API_URL;
    const prevFetch = global.fetch;
    try {
      process.env.CONTROL_API_URL = 'http://api.test';
      setOperatorAccessPolicy({
        evaluate: async () => ({ allowed: true, reason: null, approvalMode: 'consequential' }),
      });
      cache.write(conversationId, 'app-1', 'functions/send-receipt/index.ts', 'export const handler = 1');
      const artifact = functionSourceArtifact(
        'app-1:send-receipt', 'send-receipt', cache.get(conversationId, 'app-1'),
      );
      const toolArgs = { app_id: 'app-1', function_name: 'send-receipt' };
      const approval = await createApproval(pool, {
        conversationId,
        turnMessageId: randomUUID(),
        toolName: 'deploy_function_from_workspace',
        toolArgs,
        sensitivity: 'destructive',
        approvedOperation: captureApprovalOperation({
          toolName: 'deploy_function_from_workspace', args: toolArgs, artifact,
        }),
      });
      await getSharedDeployTreeStore().save(approval.id, cache.get(conversationId, 'app-1')!);
      await appendMessage(
        pool, conversationId,
        {
          role: 'assistant', content: '', toolCallId: 'call_fn_deploy',
          toolName: 'deploy_function_from_workspace', toolArgs, toolResult: null,
          modelUsed: 'claude-sonnet-4-5', pendingApprovalId: approval.id,
        },
        randomUUID(),
      );

      const bodies: unknown[] = [];
      global.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? '{}'));
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 'fn_1', url: 'https://fn.test' }),
        };
      }) as unknown as typeof fetch;

      const outcome = await resolveOperatorApproval(pool, {
        approvalId: approval.id,
        orgId,
        jwt: 'owner-jwt',
        userId: ownerId,
        authMethod: 'jwt',
        resolution: { status: 'approved' },
      });

      expect(outcome).toEqual({ ok: true });
      // The frozen inline source is what shipped — read from the tree at
      // execution time, never from the resolve body (which carries none).
      expect(bodies).toEqual([{
        name: 'send-receipt',
        code: 'export const handler = 1',
        trigger: { type: 'http' },
      }]);
    } finally {
      process.env.CONTROL_API_URL = prevApiUrl;
      if (prevApiUrl === undefined) delete process.env.CONTROL_API_URL;
      global.fetch = prevFetch;
      cache.evict(conversationId, 'app-1');
      await pool.query(`DELETE FROM dashboard_agent_conversations WHERE id = $1`, [conversationId]);
      await dropOrg(orgId);
    }
  });
});

// ---------------------------------------------------------------------------
// Regression (fix round 1): the wedge was reachable with NO crash at all.
//
// dashboard_agent_messages.tool_result is JSONB and Postgres rejects NUL
// (U+0000) with `unsupported Unicode escape sequence`. tool-bridge.ts strips
// NULs from the row it CACHES but deliberately returns the raw McpCallResult
// to its caller — so a single NUL in a tool result threw inside
// completeApprovalResolution, AFTER the tool had fired and AFTER the approval
// had flipped to 'approved': no role:'tool' row, marker uncleared, 500 to the
// caller, and a retry that 409s on the status guard. Permanent wedge, no crash
// involved. The earlier claim that only a hard crash could reach the gap was
// wrong. Sanitising happens at the persistence boundary, which fixes the human
// assistant's path too (same pre-existing bug).
// ---------------------------------------------------------------------------

describe('C2 — a NUL byte in the tool result cannot wedge the conversation', () => {
  const NUL = String.fromCharCode(0);

  it('persists the tool row, clears the marker, and throws nothing', async () => {
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool();
    mockCallMcpTool.mockResolvedValue({
      ok: true,
      result: { note: `before${NUL}after`, nested: { [`k${NUL}`]: [`v${NUL}`] } },
    });

    // No throw escapes.
    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome).toEqual({ ok: true });

    const messages = await listMessages(pool, conversationId);

    // The history is valid — this is the whole point.
    expect(unansweredToolCalls(messages)).toEqual([]);

    const toolRow = messages.find((m) => m.role === 'tool')!;
    expect(toolRow).toBeDefined();
    expect(toolRow.toolCallId).toBe(toolCallId);
    // Stored with the NULs stripped: those bytes are the only way the persisted
    // result differs from what the tool returned.
    expect(toolRow.toolResult).toEqual({ note: 'beforeafter', nested: { k: ['v'] } });

    expect(messages.every((m) => m.pendingApprovalId === null)).toBe(true);
    expect((await getApprovalForOrg(pool, approval.id, ORG))!.status).toBe('approved');
  });

  it('a NUL in a deny reason is handled the same way', async () => {
    const { conversationId, approval } = await pauseOnGatedTool();

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'denied', reason: `bad${NUL}reason` },
    });
    expect(outcome).toEqual({ ok: true });

    const messages = await listMessages(pool, conversationId);
    expect(unansweredToolCalls(messages)).toEqual([]);
    expect(messages.find((m) => m.role === 'tool')!.toolResult).toEqual({
      ok: false,
      error: 'User denied. Reason: badreason',
    });
    expect(messages.every((m) => m.pendingApprovalId === null)).toBe(true);
  });
});
