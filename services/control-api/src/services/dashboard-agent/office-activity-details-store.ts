import type pg from 'pg';
import { officeActivityStepSchema, officeToolValuePreviewSchema, officeActivityDetailsSchema, type OfficeActivityDetails, type OfficeActivityStep, type OfficeActivityStepV2, type OfficeToolValuePreview } from '@butterbase/shared';
import { previewOfficeToolValue } from './office-activity-preview.js';

type Db = Pick<pg.Pool, 'query'>;
export type OfficePreviewPhase = 'call' | 'tool_result' | 'approval_resolution';
export const unavailablePreview = (reason: OfficeToolValuePreview['reason'] = 'not_recorded'): OfficeToolValuePreview => ({ state: 'unavailable', format: 'json', redacted: false, truncated: false, reason });
const pendingPreview = (): OfficeToolValuePreview => ({ state: 'pending', format: 'json', redacted: false, truncated: false });

export async function allocateOfficeActivityInvocation(pool: pg.Pool, input: {
  id: string; conversationId: string; userMessageId: string; providerCallId: string; step: OfficeActivityStep;
  preview: OfficeToolValuePreview;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 150))', [`${input.conversationId}:${input.userMessageId}`]);
    await client.query(`INSERT INTO office_tool_activity_invocations(id,conversation_id,user_message_id,provider_call_id,ordinal,tool_name,action,step)
      SELECT $1,$2,$3,$4,COALESCE(max(ordinal),0)+1,$5,$6,$7 FROM office_tool_activity_invocations WHERE conversation_id=$2 AND user_message_id=$3`,
    [input.id, input.conversationId, input.userMessageId, input.providerCallId, input.step.tool_name, input.step.action ?? null, officeActivityStepSchema.parse(input.step)]);
    await client.query(`INSERT INTO office_tool_activity_previews(invocation_id,phase,preview,observed_status) VALUES($1,'call',$2,'running')`, [input.id, officeToolValuePreviewSchema.parse(input.preview)]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function saveOfficeActivityObservation(db: Db, input: {
  id: string; phase?: OfficePreviewPhase; preview?: OfficeToolValuePreview; step: OfficeActivityStep; approvalId?: string;
}): Promise<void> {
  // A single statement makes the optional phase and current safe metadata agree.
  if (input.phase && input.preview) await db.query(`WITH phase AS (
    INSERT INTO office_tool_activity_previews(invocation_id,phase,preview,observed_status)
    VALUES($1,$2,$3,$4) ON CONFLICT(invocation_id,phase) DO NOTHING RETURNING invocation_id)
    UPDATE office_tool_activity_invocations SET step=$5,approval_id=COALESCE($6,approval_id) WHERE id=$1`,
  [input.id, input.phase, officeToolValuePreviewSchema.parse(input.preview), input.step.status, officeActivityStepSchema.parse(input.step), input.approvalId ?? null]);
  else await db.query('UPDATE office_tool_activity_invocations SET step=$2,approval_id=COALESCE($3,approval_id) WHERE id=$1', [input.id, officeActivityStepSchema.parse(input.step), input.approvalId ?? null]);
}

type InvocationRow = { id: string; provider_call_id: string; tool_name: string; action: string | null; step: OfficeActivityStep; user_message_id: string; ordinal: number; enclosing_outcome?: string | null };
function currentPreview(raw: unknown, version: number, tool: string, action: string | null, phase: 'input' | 'result'): OfficeToolValuePreview {
  const parsed = officeToolValuePreviewSchema.safeParse(raw);
  if (version !== 1 || !parsed.success) return unavailablePreview('unsupported');
  const value = parsed.data;
  if (value.state !== 'available') return value;
  try {
    const fresh = previewOfficeToolValue(value.format === 'json' ? JSON.parse(value.text!) : value.text, { toolName: tool, ...(action ? { action } : {}), phase });
    return { ...fresh, redacted: fresh.redacted || value.redacted, truncated: fresh.truncated || value.truncated };
  } catch { return unavailablePreview('capture_failed'); }
}

/** The caller MUST authorize the exact conversation before this lookup. */
export async function readOfficeActivityDetails(db: Db, input: { conversationId: string; invocationId: string }): Promise<OfficeActivityDetails | null> {
  const result = await db.query<InvocationRow>(`SELECT i.*,t.outcome AS enclosing_outcome FROM office_tool_activity_invocations i
    LEFT JOIN dashboard_agent_office_turns t ON t.conversation_id=i.conversation_id AND t.user_message_id=i.user_message_id
    WHERE i.conversation_id=$1 AND i.id=$2`, [input.conversationId, input.invocationId]);
  const row = result.rows[0]; if (!row) return null;
  const values = await db.query<{ phase: OfficePreviewPhase; preview: unknown; policy_version: number; observed_status: OfficeActivityStep['status']; observed_at: Date }>(
    'SELECT phase,preview,policy_version,observed_status,observed_at FROM office_tool_activity_previews WHERE invocation_id=$1', [row.id]);
  const call = values.rows.find(x => x.phase === 'call');
  const output = values.rows.find(x => x.phase === 'approval_resolution') ?? values.rows.find(x => x.phase === 'tool_result');
  return officeActivityDetailsSchema.parse({ version: 1, invocation_id: row.id, provider_call_id: row.provider_call_id, tool_name: row.tool_name,
    ...(row.action ? { action: row.action } : {}),
    input: call ? currentPreview(call.preview, call.policy_version, row.tool_name, row.action, 'input') : unavailablePreview(),
    result: output ? currentPreview(output.preview, output.policy_version, row.tool_name, row.action, 'result') : row.step.status === 'running' && row.enclosing_outcome === 'running' ? pendingPreview() : unavailablePreview(),
    input_observed_at: call?.observed_at.toISOString() ?? null, result_observed_at: output?.observed_at.toISOString() ?? null,
    result_phase: output?.phase ?? null, result_status: output?.observed_status ?? null });
}

/** Called only after final authoritative resolution is persisted. Never executes. */
export async function recordOfficeActivityResolution(db: Db, input: {
  conversationId: string; approvalId: string; result: unknown; status: OfficeActivityStep['status'];
}): Promise<void> {
  try {
    const { rows } = await db.query<InvocationRow>('SELECT * FROM office_tool_activity_invocations WHERE conversation_id=$1 AND approval_id=$2 LIMIT 2', [input.conversationId, input.approvalId]);
    if (rows.length !== 1) return;
    const row = rows[0];
    const preview = previewOfficeToolValue(input.result, { toolName: row.tool_name, ...(row.action ? { action: row.action } : {}), phase: 'result' });
    await db.query(`INSERT INTO office_tool_activity_previews(invocation_id,phase,preview,observed_status)
      VALUES($1,'approval_resolution',$2,$3) ON CONFLICT(invocation_id,phase) DO NOTHING`, [row.id, preview, input.status]);
  } catch { /* Optional diagnostics cannot alter an already persisted resolution. */ }
}

export async function readOfficeActivityInvocationHistory(db: Db, conversationId: string, userIds: string[]): Promise<Array<{ user_message_id: string; steps: OfficeActivityStepV2[] }>> {
  if (!userIds.length) return [];
  try {
    const result = await db.query<InvocationRow>(`SELECT * FROM (SELECT i.*,row_number() OVER(PARTITION BY user_message_id ORDER BY ordinal DESC) AS n
      FROM office_tool_activity_invocations i WHERE conversation_id=$1 AND user_message_id=ANY($2::uuid[])) bounded
      WHERE n<=32 ORDER BY created_at DESC,ordinal DESC LIMIT 128`, [conversationId, userIds]);
    const groups = new Map<string, OfficeActivityStepV2[]>();
    for (const row of result.rows.reverse()) {
      const parsed = officeActivityStepSchema.safeParse(row.step); if (!parsed.success) continue;
      const steps = groups.get(row.user_message_id) ?? [];
      // A historical running observation remains running; only recorded terminal evidence may settle it.
      steps.push({ ...parsed.data, id: row.id, detail_ref: row.id }); groups.set(row.user_message_id, steps);
    }
    return [...groups].map(([user_message_id, steps]) => ({ user_message_id, steps }));
  } catch { return []; }
}

/** Optional mapping shares the mandatory event transaction, protected by a savepoint. */
export async function mapOfficeActivityEvent(client: pg.PoolClient, input: { conversationId: string; invocationId: string; turnId: string; sequence: number; phase: OfficePreviewPhase }): Promise<void> {
  await client.query('SAVEPOINT office_activity_mapping');
  try {
    await client.query(`UPDATE office_tool_activity_invocations SET durable_turn_id=$3,
      durable_refs=durable_refs||jsonb_build_array(jsonb_build_object('sequence',$4::integer,'phase',$5::text))
      WHERE conversation_id=$1 AND id=$2 AND (durable_turn_id IS NULL OR durable_turn_id=$3)
        AND jsonb_array_length(durable_refs)<8 AND NOT durable_refs @> jsonb_build_array(jsonb_build_object('sequence',$4::integer))`,
    [input.conversationId, input.invocationId, input.turnId, input.sequence, input.phase]);
    await client.query('RELEASE SAVEPOINT office_activity_mapping');
  } catch { await client.query('ROLLBACK TO SAVEPOINT office_activity_mapping'); await client.query('RELEASE SAVEPOINT office_activity_mapping'); }
}

export async function officeActivityEventReferences(db: Db, conversationId: string, turnId: string, sequences: number[], inTransaction = false): Promise<Map<number, { invocationId: string; toolName: string; action: string | null }>> {
  const refs = new Map<number, { invocationId: string; toolName: string; action: string | null }>(); if (!sequences.length) return refs;
  if (inTransaction) await db.query('SAVEPOINT office_activity_references');
  try {
    const { rows } = await db.query<{ id: string; tool_name: string; action: string | null; sequence: number }>(`SELECT i.id,i.tool_name,i.action,(ref->>'sequence')::integer AS sequence
      FROM office_tool_activity_invocations i CROSS JOIN LATERAL jsonb_array_elements(i.durable_refs) ref
      WHERE conversation_id=$1 AND durable_turn_id=$2 AND (ref->>'sequence')::integer=ANY($3::integer[])`, [conversationId, turnId, sequences]);
    const ambiguous = new Set<number>();
    for (const row of rows) { if (refs.has(row.sequence)) ambiguous.add(row.sequence); else refs.set(row.sequence, { invocationId: row.id, toolName: row.tool_name, action: row.action }); }
    for (const sequence of ambiguous) refs.delete(sequence);
  } catch {
    if (inTransaction) await db.query('ROLLBACK TO SAVEPOINT office_activity_references');
    refs.clear();
  } finally { if (inTransaction) await db.query('RELEASE SAVEPOINT office_activity_references'); }
  return refs;
}
