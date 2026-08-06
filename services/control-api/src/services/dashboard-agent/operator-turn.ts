import pg from 'pg';
import { runAgentTurn } from './loop.js';
import { getOrCreateOperatorConversation, operatorUserId, type OperatorJob } from './operator-store.js';
import { getOperatorCredential } from './operator-credential.js';
import { listPendingByConv } from './approvals-store.js';

export type OperatorWake =
  | { reason: 'timer' }
  | { reason: 'event'; table: string; rowId: string };

/**
 * Why a wake did no work. Distinct from both a successful turn and an error:
 * an operator waiting on a human decision is HEALTHY, and counting it as a
 * failure would misreport it. See `skipped` below.
 */
export type OperatorSkip = { reason: 'pending_approval'; approvalId: string };

export type OperatorTurnResult = {
  conversationId: string;
  events: number;
  approvalId: string | null;
  error: string | null;
  /**
   * Non-null when the wake was a deliberate no-op. `error` stays null and
   * `events` stays 0; callers must treat this as a fourth outcome alongside
   * ran / gated / errored.
   */
  skipped: OperatorSkip | null;
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
      skipped: null,
    };
  }

  const conversationId = await getOrCreateOperatorConversation(pool, job.organizationId, model);

  /**
   * Do not start a turn while a human decision is outstanding.
   *
   * An approval pause persists an assistant message carrying `tool_calls` and
   * `pending_approval_id`, with no tool row answering it. On the next wake
   * `listMessages` → `toGatewayMessages` would replay that assistant/tool_calls
   * message and then append the new `role:'user'` wake message — the
   * OpenAI-invalid sequence the gateway rejects (see resume.ts's header). There
   * is one operator conversation per org, forever, on a 1-minute tick, so the
   * operator would error on every wake until a human clicked. Approval latency
   * is the NORMAL case for this design, not an edge case.
   *
   * The honest answer is that the agent genuinely IS blocked awaiting a human,
   * so the wake reports that rather than rebuilding history to hide the pending
   * call. This also means the invalid sequence is never constructed, rather than
   * being repaired downstream.
   *
   * Checked HERE, not in the trigger, because:
   *   - this is the single chokepoint for BOTH wake reasons (timer and event);
   *     a check in the trigger would leave event wakes wedged;
   *   - the trigger has no conversation id, and obtaining one means calling
   *     `getOrCreateOperatorConversation`, which CREATES — a side effect a
   *     scheduling-layer precondition check should not have;
   *   - the invariant being protected ("never build an invalid history") is a
   *     property of the turn, not of scheduling.
   *
   * Deliberately NO TTL and NO auto-deny: expiring a human's pending decision
   * is a policy change, and not one to make here.
   */
  const pending = await listPendingByConv(pool, conversationId);
  if (pending.length > 0) {
    return {
      conversationId,
      events: 0,
      approvalId: null,
      error: null,
      skipped: { reason: 'pending_approval', approvalId: pending[0].id },
    };
  }

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

  return { conversationId, events: count, approvalId, error, skipped: null };
}
