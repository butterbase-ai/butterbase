import { describe, it, expect, vi, beforeEach, afterAll, type MockedFunction } from 'vitest';
import { Pool } from 'pg';

vi.mock('../mcp-client.js', () => ({ callMcpTool: vi.fn() }));
import * as mcpClientModule from '../mcp-client.js';
import { isOperatorToolAllowed, operatorPolicyFor, executeOnce } from '../tool-bridge.js';
import { createApproval } from '../approvals-store.js';
import { getOrCreateOperatorConversation } from '../operator-store.js';

const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;
const ORG = 'org-bridge-test';
const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query(
    `DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG]
  );
});
afterAll(async () => { await pool.end(); });

describe('isOperatorToolAllowed', () => {
  it('allows substrate and integrations', () => {
    expect(isOperatorToolAllowed('manage_substrate')).toBe(true);
    expect(isOperatorToolAllowed('manage_integrations')).toBe(true);
  });

  it('no longer rejects at the TOOL level — there is no tool-level deny tier', () => {
    // Since the 2026-08-07 spec the operator reaches the whole catalog, at one
    // of two tiers, so this helper is true for everything. `manage_billing` is
    // gated, not denied; see operatorPolicyFor / OPERATOR_TOOL_TIERS for the
    // verdict that actually governs it, and operator-policy-sufficiency.test.ts
    // for the guard that keeps every catalog tool deliberately classified.
    expect(isOperatorToolAllowed('manage_billing')).toBe(true);
    expect(operatorPolicyFor('manage_billing', {})).toBe('approval');
  });

  it('still rejects the substrate actions the operator must never call', () => {
    for (const action of ['approve', 'reject', 'set_yolo', 'resolve_policy_conflict']) {
      expect(operatorPolicyFor('manage_substrate', { action }), action).toBe('deny');
    }
  });
});

describe('executeOnce', () => {
  async function makeApproval() {
    const convId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
    return createApproval(pool, {
      conversationId: convId,
      turnMessageId: '33333333-3333-3333-3333-333333333333',
      toolName: 'manage_substrate',
      toolArgs: { action: 'propose' },
      sensitivity: 'destructive',
    });
  }

  it('executes once and caches the result', async () => {
    const approval = await makeApproval();
    mockCallMcpTool.mockResolvedValue({ ok: true, result: { id: 'act_1' } });

    const first = await executeOnce(pool, {
      approvalId: approval.id, name: 'manage_substrate',
      args: { action: 'propose' }, jwt: 'k', orgId: ORG, principal: 'operator',
    });
    const second = await executeOnce(pool, {
      approvalId: approval.id, name: 'manage_substrate',
      args: { action: 'propose' }, jwt: 'k', orgId: ORG, principal: 'operator',
    });

    expect(first).toEqual({ ok: true, result: { id: 'act_1' } });
    expect(second).toEqual({ ok: true, result: { id: 'act_1' } });
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed execution', async () => {
    const approval = await makeApproval();
    mockCallMcpTool.mockResolvedValue({ ok: false, error: 'boom' });

    await executeOnce(pool, {
      approvalId: approval.id, name: 'manage_substrate',
      args: {}, jwt: 'k', orgId: ORG, principal: 'operator',
    });
    await executeOnce(pool, {
      approvalId: approval.id, name: 'manage_substrate',
      args: {}, jwt: 'k', orgId: ORG, principal: 'operator',
    });

    expect(mockCallMcpTool).toHaveBeenCalledTimes(2);
  });

  // Regression: before the advisory-lock fix both concurrent callers missed
  // the cache SELECT and both fired the tool (measured: 2 calls). ON CONFLICT
  // DO NOTHING protected the ledger row but not the side effect.
  it('executes once even when two callers race the same approval', async () => {
    const approval = await makeApproval();
    mockCallMcpTool.mockImplementation(async () => {
      // Hold the transaction open long enough that a naive implementation's
      // second caller would certainly have passed its cache SELECT by now.
      await new Promise((r) => setTimeout(r, 100));
      return { ok: true, result: { id: 'act_1' } };
    });

    const args = {
      approvalId: approval.id, name: 'manage_substrate',
      args: { action: 'propose' }, jwt: 'k', orgId: ORG, principal: 'operator' as const,
    };
    // Warm two pool connections first, so neither caller is serialised behind
    // connection setup rather than the lock (keeps the race deterministic).
    const warm = await Promise.all([pool.connect(), pool.connect()]);
    warm.forEach((c) => c.release());

    const [first, second] = await Promise.all([
      executeOnce(pool, args),
      executeOnce(pool, args),
    ]);

    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ ok: true, result: { id: 'act_1' } });
    expect(second).toEqual(first);

    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM dashboard_agent_tool_executions WHERE approval_id = $1`,
      [approval.id],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  // Regression: PostgreSQL rejects NUL inside JSONB, so the INSERT used to
  // throw *after* the tool had fired — nothing recorded, retry re-executes.
  it('records a successful execution whose result contains a NUL byte', async () => {
    const approval = await makeApproval();
    const NUL = String.fromCharCode(0);
    mockCallMcpTool.mockResolvedValue({ ok: true, result: { s: `a${NUL}b` } });

    const args = {
      approvalId: approval.id, name: 'manage_substrate',
      args: {}, jwt: 'k', orgId: ORG, principal: 'operator' as const,
    };
    const first = await executeOnce(pool, args);
    expect(first).toEqual({ ok: true, result: { s: `a${NUL}b` } });

    // The execution was recorded, so the replay is served from cache.
    const second = await executeOnce(pool, args);
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ ok: true, result: { s: 'ab' } });
  });

  it('refuses a denied substrate action without calling MCP', async () => {
    // `manage_billing` used to be the example here; it is now gated rather than
    // denied, and a gated tool IS executable through executeOnce (this path
    // only ever runs an approval a human already resolved). The self-approval
    // guard is what still refuses before any MCP call.
    const approval = await makeApproval();
    const r = await executeOnce(pool, {
      approvalId: approval.id, name: 'manage_substrate',
      args: { action: 'approve', action_id: 'act_1' }, jwt: 'k', orgId: ORG, principal: 'operator',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not permitted');
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });
});
