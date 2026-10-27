import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApproval, getApproval } from './approvals-store.js';
import type { ApprovalReference } from './approvals-store.js';

const connectionString = process.env.CONTROL_TEST_DATABASE_URL;
const dbDescribe = connectionString ? describe : describe.skip;

dbDescribe('approval references', () => {
  const conversationId = randomUUID();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await pool.query(
      `INSERT INTO dashboard_agent_conversations (id, user_id, title, model)
       VALUES ($1, 'approval-store-test', 'Approval store', 'synthetic')`,
      [conversationId],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM dashboard_agent_conversations WHERE id=$1', [conversationId]);
    await pool.end();
  });

  const base = () => ({
    conversationId,
    turnMessageId: randomUUID(),
    toolName: 'manage_substrate',
    toolArgs: { action: 'propose' },
    sensitivity: 'destructive' as const,
  });

  it('round-trips references and defaults an approval without them to []', async () => {
    const references: ApprovalReference[] = [
      { kind: 'record', id: 'ent_1', label: 'Marcus Webb', detail: 'person' },
      { kind: 'file', label: 'Invoice #1042' },
    ];

    const created = await createApproval(pool, { ...base(), references });
    expect(created.references).toEqual(references);

    const read = await getApproval(pool, created.id, 'approval-store-test');
    expect(read?.references).toEqual(references);

    const bare = await createApproval(pool, base());
    expect(bare.references).toEqual([]);
  });
});
