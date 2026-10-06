import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createApproval, getApprovalForOrg, listPendingByOrg } from '../approvals-store.js';
import { getOrCreateOperatorConversation } from '../operator-store.js';

const ORG = 'org-approvals-test';
const OTHER_ORG = 'org-other';
const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

beforeEach(async () => {
  await pool.query(
    `DELETE FROM dashboard_agent_approvals WHERE conversation_id IN
       (SELECT id FROM dashboard_agent_conversations WHERE organization_id = ANY($1))`,
    [[ORG, OTHER_ORG]],
  );
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = ANY($1)`, [[ORG, OTHER_ORG]]);
});
afterAll(async () => { await pool.end(); });

describe('org-scoped approvals', () => {
  it('finds an approval by org, not by user', async () => {
    const convId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
    const created = await createApproval(pool, {
      conversationId: convId,
      turnMessageId: '11111111-1111-1111-1111-111111111111',
      toolName: 'manage_app',
      toolArgs: { action: 'delete' },
      sensitivity: 'destructive',
    });

    const found = await getApprovalForOrg(pool, created.id, ORG);
    expect(found?.id).toBe(created.id);
  });

  it('does not leak approvals across orgs', async () => {
    const convId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
    const created = await createApproval(pool, {
      conversationId: convId,
      turnMessageId: '22222222-2222-2222-2222-222222222222',
      toolName: 'manage_app',
      toolArgs: { action: 'delete' },
      sensitivity: 'destructive',
    });

    expect(await getApprovalForOrg(pool, created.id, OTHER_ORG)).toBeNull();
    expect(await listPendingByOrg(pool, OTHER_ORG)).toHaveLength(0);
    expect(await listPendingByOrg(pool, ORG)).toHaveLength(1);
  });

  // The operator approval routes authorise on org membership alone. If these
  // lookups matched *any* conversation carrying an organization_id, then the
  // moment anything backfills that column on human chats — a migration, an
  // analytics feature, org-scoped chat — every org member could read another
  // member's tool_args and execute their gated tool calls. The scope must be
  // structurally operator-only, not incidentally so.
  it('ignores non-operator conversations that carry the same organization_id', async () => {
    const operatorConvId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
    const operatorApproval = await createApproval(pool, {
      conversationId: operatorConvId,
      turnMessageId: '33333333-3333-3333-3333-333333333333',
      toolName: 'manage_substrate',
      toolArgs: { action: 'propose' },
      sensitivity: 'destructive',
    });

    // A human chat that happens to carry organization_id for the same org.
    const humanConv = await pool.query<{ id: string }>(
      `INSERT INTO dashboard_agent_conversations (organization_id, user_id, title, model)
       VALUES ($1, $2, 'Human chat', 'claude-sonnet-4-5') RETURNING id`,
      [ORG, 'human-user-id'],
    );
    const humanApproval = await createApproval(pool, {
      conversationId: humanConv.rows[0].id,
      turnMessageId: '44444444-4444-4444-4444-444444444444',
      toolName: 'manage_substrate',
      toolArgs: { action: 'propose', secret: 'human-only' },
      sensitivity: 'destructive',
    });

    // The human's approval must be invisible and unresolvable via the org path.
    expect(await getApprovalForOrg(pool, humanApproval.id, ORG)).toBeNull();

    const pending = await listPendingByOrg(pool, ORG);
    expect(pending.map((a) => a.id)).toEqual([operatorApproval.id]);
  });
});
