import pg from 'pg';
import { runAgentTurn } from './loop.js';
import { getOrCreateOperatorConversation, type OperatorJob } from './operator-store.js';

// Mirrors operator-store.ts's operatorUserId(orgId) sentinel format. Not
// imported from there directly: the module-level vi.mock in
// operator-turn.test.ts only stubs getOrCreateOperatorConversation, so
// importing operatorUserId from the same mocked module would resolve to
// undefined at test time. Keep this in sync with operator-store.ts if that
// format ever changes.
function operatorUserId(orgId: string): string {
  return `operator:${orgId}`;
}
import { getOperatorCredential } from './operator-credential.js';

export type OperatorWake =
  | { reason: 'timer' }
  | { reason: 'event'; table: string; rowId: string };

export type OperatorTurnResult = {
  conversationId: string;
  events: number;
  approvalId: string | null;
  error: string | null;
};

const DEFAULT_MODEL = 'claude-sonnet-4-5';

/**
 * The wake reason is advisory. pg_notify is fire-and-forget, so events can be
 * dropped entirely — a timer wake and an event wake must do the same work.
 * The agent is told what changed as a hint, and told to reconcile regardless.
 */
function buildWakeMessage(job: OperatorJob, wake: OperatorWake): string {
  const preamble =
    wake.reason === 'timer'
      ? 'Scheduled wake.'
      : `Woken by a change to ${wake.table} (row ${wake.rowId}).`;

  return [
    preamble,
    'Treat this only as a hint that something may have changed — re-read current state and reconcile before acting.',
    '',
    job.instructions,
  ].join('\n');
}

export async function runOperatorTurn(
  pool: pg.Pool,
  opts: { job: OperatorJob; wake: OperatorWake; model?: string },
): Promise<OperatorTurnResult> {
  const { job, wake } = opts;
  const model = opts.model ?? DEFAULT_MODEL;

  const credential = await getOperatorCredential(pool, job.organizationId);
  if (!credential) {
    return {
      conversationId: '',
      events: 0,
      approvalId: null,
      error: `no operator credential for org ${job.organizationId}`,
    };
  }

  const conversationId = await getOrCreateOperatorConversation(pool, job.organizationId, model);

  let count = 0;
  let approvalId: string | null = null;
  let error: string | null = null;

  try {
    const gen = runAgentTurn({
      conversationId,
      userId: operatorUserId(job.organizationId),
      jwt: credential,
      userMessage: buildWakeMessage(job, wake),
      model,
      pool,
      organizationId: job.organizationId,
    });

    for await (const event of gen) {
      count++;
      if (event.type === 'approval_required') approvalId = event.approval_id;
      if (event.type === 'error') error = event.message;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return { conversationId, events: count, approvalId, error };
}
