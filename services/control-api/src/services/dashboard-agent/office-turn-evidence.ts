import type pg from 'pg';
import type { LoopEvent } from './loop.js';
import { attachOfficeActivityObservation, type OfficeActivityDetailRecorder } from './office-activity-details-recorder.js';

/** Runtime-owned evidence, never derived from assistant prose or tool success. */
export class OfficeTurnEvidence {
  private anchor: string | null = null;
  private finalAnswer: string | null = null;
  private outcome = 'running';
  constructor(private pool: pg.Pool, private conversationId: string, private resumeApprovalId?: string) {}

  async start(userMessageId: string): Promise<void> {
    if (this.resumeApprovalId) {
      // Only a previously recorded pause is resumable evidence. Legacy stays unknown.
      const result = await this.pool.query(`UPDATE dashboard_agent_office_turns
        SET outcome='running',final_answer_id=NULL,updated_at=now()
        WHERE conversation_id=$1 AND approval_id=$2 AND outcome IN ('unknown','awaiting_approval')
        RETURNING user_message_id`, [this.conversationId, this.resumeApprovalId]);
      this.anchor = result.rows[0]?.user_message_id ?? null;
    } else {
      await this.pool.query(`INSERT INTO dashboard_agent_office_turns(user_message_id,conversation_id,outcome)
        VALUES($1,$2,'running')`, [userMessageId, this.conversationId]);
      this.anchor = userMessageId;
    }
  }
  /** Called only after persisting the no-tool-calls final assistant message. */
  answer(messageId: string): void { this.finalAnswer = messageId; }
  async observe(event: LoopEvent): Promise<void> {
    if (event.type === 'approval_required') await this.write('awaiting_approval', event.approval_id);
    else if (event.type === 'error') await this.write('failed');
    else if (event.type === 'blocked') await this.write('interrupted');
    else if (event.type === 'done') await this.write(this.finalAnswer ? 'completed' : 'unknown');
  }
  async finish(): Promise<void> { if (this.outcome === 'running') await this.write('unknown'); }
  async fail(): Promise<void> { await this.write('failed'); }
  private async write(outcome: string, approvalId?: string): Promise<void> {
    if (!this.anchor) return;
    await this.pool.query(`UPDATE dashboard_agent_office_turns
      SET outcome=$3,final_answer_id=$4,approval_id=COALESCE($5,approval_id),updated_at=now()
      WHERE conversation_id=$1 AND user_message_id=$2`,
    [this.conversationId, this.anchor, outcome, outcome === 'completed' ? this.finalAnswer : null, approvalId ?? null]);
    this.outcome = outcome;
  }
}

/** Drained by the server independently of browser observation. */
export async function* observeOfficeTurn(source: AsyncGenerator<LoopEvent>, evidence?: OfficeTurnEvidence, details?: OfficeActivityDetailRecorder): AsyncGenerator<LoopEvent> {
  try {
    for await (const event of source) {
      const observation = await details?.observe(event);
      if (observation) attachOfficeActivityObservation(event, observation);
      await evidence?.observe(event); yield event;
    }
  } catch (error) { await evidence?.fail(); throw error; }
  finally { await details?.observe({ type: 'done' }); await evidence?.finish(); }
}

/** Resolution establishes a tool result, not an enclosing final answer. */
export async function resolveOfficeTurnApproval(pool: pg.Pool, conversationId: string, approvalId: string): Promise<void> {
  await pool.query(`UPDATE dashboard_agent_office_turns SET outcome='unknown',final_answer_id=NULL,updated_at=now()
    WHERE conversation_id=$1 AND approval_id=$2 AND outcome='awaiting_approval'`, [conversationId, approvalId]);
}
