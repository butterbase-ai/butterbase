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
});
