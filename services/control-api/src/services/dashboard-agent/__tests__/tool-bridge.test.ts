import { describe, it, expect, vi, beforeEach, afterAll, type MockedFunction } from 'vitest';
import { Pool } from 'pg';

vi.mock('../mcp-client.js', () => ({ callMcpTool: vi.fn() }));
import * as mcpClientModule from '../mcp-client.js';
import { isOperatorToolAllowed, executeOnce } from '../tool-bridge.js';
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

  it('rejects tools outside the allowlist', () => {
    expect(isOperatorToolAllowed('manage_billing')).toBe(false);
    expect(isOperatorToolAllowed('not_a_real_tool')).toBe(false);
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
      args: { action: 'propose' }, jwt: 'k', orgId: ORG,
    });
    const second = await executeOnce(pool, {
      approvalId: approval.id, name: 'manage_substrate',
      args: { action: 'propose' }, jwt: 'k', orgId: ORG,
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
      args: {}, jwt: 'k', orgId: ORG,
    });
    await executeOnce(pool, {
      approvalId: approval.id, name: 'manage_substrate',
      args: {}, jwt: 'k', orgId: ORG,
    });

    expect(mockCallMcpTool).toHaveBeenCalledTimes(2);
  });

  it('refuses a tool outside the allowlist without calling MCP', async () => {
    const approval = await makeApproval();
    const r = await executeOnce(pool, {
      approvalId: approval.id, name: 'manage_billing',
      args: {}, jwt: 'k', orgId: ORG,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not permitted');
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });
});
