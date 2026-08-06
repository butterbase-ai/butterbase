import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createApproval,
  getApproval,
  listPendingByConv,
  resolveApproval,
  checkTrust,
  findResumableApproval,
  markApprovalResumed,
  type Approval,
} from '../approvals-store.js';

describe('Approvals Store', () => {
  let pool: pg.Pool;
  let testUserId: string;
  let otherUserId: string;
  let conversationId: string;
  let otherConversationId: string;

  beforeAll(async () => {
    // Create a direct pool connection for testing
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control',
      max: 10,
    });

    // Use unique emails to avoid collisions in tests that rerun
    const timestamp = Date.now();
    const email1 = `approval-test-user-${timestamp}-1@example.com`;
    const email2 = `approval-test-user-${timestamp}-2@example.com`;

    // Create first test user with personal organization
    const org1Result = await pool.query(
      `INSERT INTO organizations (name, owner_id, personal)
       VALUES (gen_random_uuid()::text, gen_random_uuid(), true)
       RETURNING id`
    );
    const org1Id = org1Result.rows[0].id;

    const user1Result = await pool.query(
      `INSERT INTO platform_users (email, cognito_sub, personal_organization_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [email1, `approval-test-sub-${timestamp}-1`, org1Id]
    );
    testUserId = user1Result.rows[0].id;

    // Update organization owner to the user
    await pool.query(
      `UPDATE organizations SET owner_id = $1 WHERE id = $2`,
      [testUserId, org1Id]
    );

    // Create second test user with personal organization
    const org2Result = await pool.query(
      `INSERT INTO organizations (name, owner_id, personal)
       VALUES (gen_random_uuid()::text, gen_random_uuid(), true)
       RETURNING id`
    );
    const org2Id = org2Result.rows[0].id;

    const user2Result = await pool.query(
      `INSERT INTO platform_users (email, cognito_sub, personal_organization_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [email2, `approval-test-sub-${timestamp}-2`, org2Id]
    );
    otherUserId = user2Result.rows[0].id;

    // Update organization owner to the user
    await pool.query(
      `UPDATE organizations SET owner_id = $1 WHERE id = $2`,
      [otherUserId, org2Id]
    );

    // Create two conversations for the first user
    const conv1Result = await pool.query(
      `INSERT INTO dashboard_agent_conversations (user_id, title, model)
       VALUES ($1, 'Test Conversation 1', 'claude-3-5-sonnet')
       RETURNING id`,
      [testUserId]
    );
    conversationId = conv1Result.rows[0].id;

    const conv2Result = await pool.query(
      `INSERT INTO dashboard_agent_conversations (user_id, title, model)
       VALUES ($1, 'Test Conversation 2', 'claude-3-5-sonnet')
       RETURNING id`,
      [testUserId]
    );
    otherConversationId = conv2Result.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data - order matters due to foreign keys
    await pool.query(
      'DELETE FROM dashboard_agent_approvals WHERE conversation_id IN (SELECT id FROM dashboard_agent_conversations WHERE user_id IN ($1, $2))',
      [testUserId, otherUserId]
    );
    await pool.query(
      'DELETE FROM dashboard_agent_messages WHERE conversation_id IN (SELECT id FROM dashboard_agent_conversations WHERE user_id IN ($1, $2))',
      [testUserId, otherUserId]
    );
    await pool.query(
      'DELETE FROM dashboard_agent_conversations WHERE user_id IN ($1, $2)',
      [testUserId, otherUserId]
    );
    // Delete organization memberships (but we created them as personal orgs so this may be empty)
    await pool.query(
      `DELETE FROM organization_members WHERE user_id IN ($1, $2)`,
      [testUserId, otherUserId]
    );
    // Delete the platform users first (before deleting organizations they own)
    await pool.query(
      'DELETE FROM platform_users WHERE id IN ($1, $2)',
      [testUserId, otherUserId]
    );
    // Now delete the organizations
    await pool.query(
      `DELETE FROM organizations WHERE id IN (
        SELECT personal_organization_id FROM platform_users WHERE id IN ($1, $2)
      )`,
      [testUserId, otherUserId]
    );

    await pool.end();
  });

  it('createApproval → row exists', async () => {
    const approval = await createApproval(pool, {
      conversationId,
      turnMessageId: '00000000-0000-0000-0000-000000000001',
      toolName: 'deploy_app',
      toolArgs: { appId: 'test-app-1' },
      sensitivity: 'destructive',
    });

    expect(approval.id).toBeDefined();
    expect(approval.conversationId).toBe(conversationId);
    expect(approval.turnMessageId).toBe('00000000-0000-0000-0000-000000000001');
    expect(approval.toolName).toBe('deploy_app');
    expect(approval.sensitivity).toBe('destructive');
    expect(approval.status).toBe('pending');
    expect(approval.trustScope).toBeNull();
    expect(approval.denyReason).toBeNull();
    expect(approval.createdAt).toBeDefined();
    expect(approval.resolvedAt).toBeNull();
  });

  it('getApproval owner path', async () => {
    const approval = await createApproval(pool, {
      conversationId,
      turnMessageId: '00000000-0000-0000-0000-000000000002',
      toolName: 'delete_app',
      toolArgs: { appId: 'test-app-2' },
      sensitivity: 'destructive',
    });

    const retrieved = await getApproval(pool, approval.id, testUserId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(approval.id);
    expect(retrieved?.toolName).toBe('delete_app');
  });

  it('getApproval cross-tenant returns null', async () => {
    const approval = await createApproval(pool, {
      conversationId,
      turnMessageId: '00000000-0000-0000-0000-000000000003',
      toolName: 'modify_schema',
      toolArgs: { schemaId: 'schema-1' },
      sensitivity: 'confirm',
    });

    // Try to access with a different user
    const retrieved = await getApproval(pool, approval.id, otherUserId);
    expect(retrieved).toBeNull();
  });

  it('resolveApproval sets status + resolved_at', async () => {
    const approval = await createApproval(pool, {
      conversationId,
      turnMessageId: '00000000-0000-0000-0000-000000000004',
      toolName: 'deploy_function',
      toolArgs: { functionName: 'test-fn' },
      sensitivity: 'confirm',
    });

    await resolveApproval(pool, approval.id, {
      status: 'approved',
      trustScope: 'conversation',
    });

    const retrieved = await getApproval(pool, approval.id, testUserId);
    expect(retrieved?.status).toBe('approved');
    expect(retrieved?.trustScope).toBe('conversation');
    expect(retrieved?.resolvedAt).not.toBeNull();
  });

  it('resolveApproval with deny reason', async () => {
    const approval = await createApproval(pool, {
      conversationId,
      turnMessageId: '00000000-0000-0000-0000-000000000005',
      toolName: 'delete_table',
      toolArgs: { tableName: 'sensitive_data' },
      sensitivity: 'destructive',
    });

    await resolveApproval(pool, approval.id, {
      status: 'denied',
      denyReason: 'User rejected destructive operation',
    });

    const retrieved = await getApproval(pool, approval.id, testUserId);
    expect(retrieved?.status).toBe('denied');
    expect(retrieved?.denyReason).toBe('User rejected destructive operation');
    expect(retrieved?.resolvedAt).not.toBeNull();
  });

  it('checkTrust returns true for trusted', async () => {
    const approval = await createApproval(pool, {
      conversationId,
      turnMessageId: '00000000-0000-0000-0000-000000000006',
      toolName: 'trusted_tool',
      toolArgs: { id: 'test-1' },
      sensitivity: 'confirm',
    });

    // Resolve with trust scope
    await resolveApproval(pool, approval.id, {
      status: 'approved',
      trustScope: 'conversation',
    });

    const trusted = await checkTrust(pool, conversationId, 'trusted_tool');
    expect(trusted).toBe(true);
  });

  it('checkTrust returns false for not-trusted', async () => {
    // Create but don't approve with trust scope
    const approval = await createApproval(pool, {
      conversationId: otherConversationId,
      turnMessageId: '00000000-0000-0000-0000-000000000007',
      toolName: 'some_tool',
      toolArgs: { id: 'test-2' },
      sensitivity: 'confirm',
    });

    // Approve without trust scope
    await resolveApproval(pool, approval.id, {
      status: 'approved',
    });

    const trusted = await checkTrust(pool, otherConversationId, 'some_tool');
    expect(trusted).toBe(false);
  });

  it('checkTrust returns false for denied approval', async () => {
    const approval = await createApproval(pool, {
      conversationId,
      turnMessageId: '00000000-0000-0000-0000-000000000008',
      toolName: 'denied_tool',
      toolArgs: { id: 'test-3' },
      sensitivity: 'destructive',
    });

    // Deny the approval
    await resolveApproval(pool, approval.id, {
      status: 'denied',
      denyReason: 'Security concern',
    });

    const trusted = await checkTrust(pool, conversationId, 'denied_tool');
    expect(trusted).toBe(false);
  });

  it('listPendingByConv returns only pending', async () => {
    // Create a pending approval
    const pending = await createApproval(pool, {
      conversationId,
      turnMessageId: '00000000-0000-0000-0000-000000000009',
      toolName: 'pending_tool',
      toolArgs: { id: 'test-4' },
      sensitivity: 'confirm',
    });

    // Create an approved approval
    const approved = await createApproval(pool, {
      conversationId,
      turnMessageId: '00000000-0000-0000-0000-000000000010',
      toolName: 'approved_tool',
      toolArgs: { id: 'test-5' },
      sensitivity: 'confirm',
    });
    await resolveApproval(pool, approved.id, {
      status: 'approved',
    });

    // List pending
    const pendingList = await listPendingByConv(pool, conversationId);
    const pendingIds = pendingList.map(a => a.id);

    expect(pendingIds).toContain(pending.id);
    expect(pendingIds).not.toContain(approved.id);
  });

  /**
   * Task D1's core persistence claim, exercised against real Postgres.
   *
   * The gate-boundary test in operator-turn.test.ts mocks `findResumableApproval`
   * and `markApprovalResumed` — it proves the wiring INSIDE `runOperatorTurn`,
   * but never that `createApproval` actually writes `trace_id`, that the
   * `resumed_at IS NULL` predicate reads it back, or that `markApprovalResumed`
   * makes the second call return null. A typo in either predicate (e.g.
   * `resumed_at IS NOT NULL`, or a forgotten `trace_id` in the INSERT column
   * list) would pass every mocked test in the repo and silently mint a fresh
   * id on every resume in production. This is the test that would catch it.
   */
  describe('trace id persistence round trip (D1)', () => {
    it('createApproval -> resolveApproval -> findResumableApproval returns it -> markApprovalResumed -> findResumableApproval returns null', async () => {
      const approval = await createApproval(pool, {
        conversationId,
        turnMessageId: '00000000-0000-0000-0000-000000000011',
        toolName: 'manage_substrate',
        toolArgs: { action: 'propose' },
        sensitivity: 'destructive',
        traceId: 'optr_roundtrip-test',
      });

      // Written on INSERT, readable back before any resolution.
      const fetched = await getApproval(pool, approval.id, testUserId);
      expect(fetched?.traceId).toBe('optr_roundtrip-test');
      expect(fetched?.resumedAt).toBeNull();

      // Still pending -> NOT resumable. findResumableApproval only ever
      // returns a RESOLVED gate (see its `status != 'pending'` predicate) —
      // a still-open gate is not something a later wake should "resume" past.
      expect(await findResumableApproval(pool, conversationId)).toBeNull();

      // A human resolves it — this is the moment a later wake becomes able
      // to resume the conversation.
      await resolveApproval(pool, approval.id, { status: 'approved' });

      const resumable = await findResumableApproval(pool, conversationId);
      expect(resumable?.id).toBe(approval.id);
      expect(resumable?.traceId).toBe('optr_roundtrip-test');
      expect(resumable?.resumedAt).toBeNull();

      // The wake that actually resumes commits the mark...
      await markApprovalResumed(pool, approval.id);

      // ...and every wake after that must NOT see it as resumable again, or
      // the same trace id would be replayed forever instead of once.
      expect(await findResumableApproval(pool, conversationId)).toBeNull();

      const afterMark = await getApproval(pool, approval.id, testUserId);
      expect(afterMark?.resumedAt).not.toBeNull();

      // Idempotent: a second mark (e.g. a retried wake) must not throw and
      // must not "re-arm" the row.
      await markApprovalResumed(pool, approval.id);
      expect(await findResumableApproval(pool, conversationId)).toBeNull();
    });

    it('a resolved approval with NO trace id is never offered as resumable', async () => {
      const approval = await createApproval(pool, {
        conversationId,
        turnMessageId: '00000000-0000-0000-0000-000000000012',
        toolName: 'manage_app',
        toolArgs: { action: 'delete' },
        sensitivity: 'destructive',
        // No traceId — this is the human assistant's shape, which has no trace.
      });
      await resolveApproval(pool, approval.id, { status: 'approved' });

      const resumable = await findResumableApproval(pool, conversationId);
      // Either genuinely null, or (if an earlier row in this conversation is
      // still legitimately resumable) definitely not THIS approval.
      expect(resumable?.id).not.toBe(approval.id);
    });
  });
});
