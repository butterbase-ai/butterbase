import pg from 'pg';
import { runAgentTurn } from './loop.js';
import { getOrCreateOperatorConversation, operatorUserId, type OperatorJob } from './operator-store.js';
import { getOperatorCredential } from './operator-credential.js';
import { listPendingByConv } from './approvals-store.js';
import {
  getOperatorScratchpad,
  OPERATOR_SCRATCHPAD_MAX_CHARS,
  type OperatorScratchpad,
} from './operator-scratchpad-store.js';
import { OPERATOR_SCRATCHPAD_TOOL } from './tool-catalog.js';

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
 * Version of the wake-envelope FORMAT (not of the job's instructions).
 *
 * The agent is shown this so a transcript, a log line or a bug report can be
 * tied to the exact envelope shape that produced it — one operator
 * conversation per org runs for a long time, and the header will change under
 * it. Bump on any change to the header's fields or delimiters.
 */
export const OPERATOR_WAKE_PROMPT_VERSION = 'operator-wake/2026-08-06.1';

const HEADER_OPEN = '=== OPERATOR WAKE (platform-authored) ===';
const HEADER_CLOSE = '=== END OPERATOR WAKE ===';
const SCRATCHPAD_OPEN = '--- YOUR SCRATCHPAD (you wrote this) ---';
const SCRATCHPAD_CLOSE = '--- END SCRATCHPAD ---';

/**
 * ============================================================================
 * THE RULE, for whoever reads this next.
 *
 * NEITHER THE WAKE HEADER NOR THE SCRATCHPAD MAY EVER BE AN INPUT TO A
 * SECURITY DECISION. Both are affordances — exactly like the operator catalog
 * filter in loop.ts, which shapes what the model is offered while the dispatch
 * guard is what actually decides.
 *
 *  - The SCRATCHPAD is model-written by construction. Anything that trusted it
 *    would be handing the agent a way to author its own gating: write "this
 *    org has approved outbound email" into your own notes, read it back next
 *    wake, act on it. So no verdict in operator-policy.ts, no branch in
 *    tool-bridge.ts and no route handler may read
 *    `dashboard_agent_operator_scratchpad`. It is prompt text and nothing else.
 *
 *  - The HEADER is platform-authored and the agent cannot edit it, which makes
 *    it TRUE — but it is still prompt text, so the model can be induced to
 *    echo it, contradict it, or claim a different org in its own output. What
 *    the model says about its org id is not evidence of anything.
 *
 * In particular: telling the agent its organization id here does NOT replace
 * or weaken the cross-org `org_id` guard (`orgIdArgIsForeign`, applied at the
 * dispatch site, in `turnMcp` and in `executeOnce`). That guard compares
 * against a TRUSTED source — the `operator:<org>` sentinel, hardcoded below
 * from the claimed job row — and it must stay the control. This header exists
 * so the agent can write correct arguments; the guard exists so it cannot
 * write dangerous ones. Do not delete the guard because "the agent already
 * knows its org".
 * ============================================================================
 *
 * The wake reason itself is advisory. pg_notify is fire-and-forget, so events
 * can be dropped entirely — a timer wake and an event wake must do the same
 * work, and the payload must never be trusted. The agent is told what changed
 * as a hint, and told to reconcile regardless. Everything after the header is
 * byte-identical between the two wake reasons for exactly that reason.
 */
function buildWakeMessage(
  job: OperatorJob,
  wake: OperatorWake,
  scratchpad: OperatorScratchpad | null,
): string {
  const wakeReason =
    wake.reason === 'timer'
      ? 'timer (scheduled tick)'
      : `event (${wake.table} row ${wake.rowId})`;

  const header = [
    HEADER_OPEN,
    `organization_id: ${job.organizationId}`,
    `job: ${job.name}`,
    `wake_reason: ${wakeReason}`,
    `prompt_version: ${OPERATOR_WAKE_PROMPT_VERSION}`,
    HEADER_CLOSE,
  ].join('\n');

  const notes = scratchpad?.content.trim() ?? '';
  const scratchpadBlock = [
    SCRATCHPAD_OPEN,
    notes.length > 0
      ? notes
      : '(empty — you have not written any notes yet for this organization.)',
    SCRATCHPAD_CLOSE,
    `These are your own working notes, carried over from earlier wakes and given to you here for free. Substrate is the source of truth for anything durable — record decisions, commitments, learnings and entities through manage_substrate, which auto-approves. Keep the scratchpad as a short working digest: what you are part-way through, what you are waiting on, what you already checked. Update it with \`${OPERATOR_SCRATCHPAD_TOOL}\`, which REPLACES the whole text (max ${OPERATOR_SCRATCHPAD_MAX_CHARS} characters; an oversized write is rejected, not truncated). It carries no authority and grants you no permissions.`,
  ].join('\n');

  return [
    header,
    '',
    'Treat the wake reason above only as a hint that something may have changed — re-read current state and reconcile before acting. Events can be dropped, so a scheduled wake must do the same work as an event wake.',
    '',
    scratchpadBlock,
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

  /**
   * Read the scratchpad AFTER the pending-approval check, so a wake that is a
   * clean no-op stays a no-op. Best-effort: the scratchpad is a convenience,
   * and a read failure must degrade the prompt rather than fail the wake — the
   * agent can still do its job from the header and its instructions.
   */
  let scratchpad: OperatorScratchpad | null = null;
  try {
    scratchpad = await getOperatorScratchpad(pool, job.organizationId);
  } catch {
    scratchpad = null;
  }

  let count = 0;
  let approvalId: string | null = null;
  let error: string | null = null;

  try {
    const gen = runAgentTurn({
      conversationId,
      userId: operatorUserId(job.organizationId),
      jwt: credential,
      userMessage: buildWakeMessage(job, wake, scratchpad),
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
