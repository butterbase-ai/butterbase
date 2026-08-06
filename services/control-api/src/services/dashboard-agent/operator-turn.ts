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

/**
 * ============================================================================
 * MODEL ID — DO NOT "TIDY" THIS BACK TO A BARE `claude-*` ID.
 *
 * The AI gateway's catalog is PROVIDER-PREFIXED. Every one of the ~398 model
 * ids returned by `GET /v1/models` carries a provider segment; there is not a
 * single bare `claude-*` id among them. The sonnets are
 * `anthropic/claude-sonnet-4`, `anthropic/claude-sonnet-4.5`,
 * `anthropic/claude-sonnet-4.6`, `anthropic/claude-sonnet-5` — note also the
 * DOT in `4.5`, not a dash.
 *
 * This default used to read `claude-sonnet-4-5`. Verified live against a
 * running gateway on 2026-08-06:
 *
 *   POST /v1/chat/completions {"model":"claude-sonnet-4-5"}
 *     -> HTTP 404 {"error":{"message":"Model not found: claude-sonnet-4-5",
 *                            "code":"model_not_found"}}
 *
 * i.e. EVERY operator wake died at the first gateway call, and the deployment
 * was silently dead — the failure surfaced only as an `errors` counter. No unit
 * test caught it because they all mock the gateway. `anthropic/claude-sonnet-4.5`
 * was driven end-to-end (203 events, real tool calls, a real gate) and is the
 * verified-routable default.
 *
 * PRECEDENCE (highest first):
 *   1. `opts.model` — an explicit caller-supplied id always wins.
 *   2. `process.env.OPERATOR_MODEL` — deployment override, so an operator can
 *      move to a different catalog id with no code change (mirrors how
 *      OPERATOR_ENABLED / OPERATOR_CRED_KEY are handled).
 *   3. `DEFAULT_OPERATOR_MODEL` below.
 *
 * The env var is read LAZILY, per call, exactly like `OPERATOR_CRED_KEY` in
 * operator-credential.ts — so it can be changed without a rebuild and so tests
 * can set it without import-order games.
 * ============================================================================
 */
export const DEFAULT_OPERATOR_MODEL = 'anthropic/claude-sonnet-4.5';

/** Resolve the model for a wake. See the precedence note above. */
export function resolveOperatorModel(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit;
  const env = process.env.OPERATOR_MODEL?.trim();
  if (env && env.length > 0) return env;
  return DEFAULT_OPERATOR_MODEL;
}

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

/**
 * Result of `operatorPreflight`: either the turn should proceed with the
 * enclosed credential/conversation, or it should stop right here and return
 * the enclosed terminal result without ever reaching `runAgentTurn`.
 */
export type OperatorPreflight =
  | { ok: true; credential: string; conversationId: string }
  | { ok: false; result: OperatorTurnResult };

/**
 * The cheap precondition check for a wake, extracted so a caller can run it
 * BEFORE paying for anything a full turn would otherwise cost — most
 * concretely, `SandboxRunner` calling this before `createSandbox`.
 *
 * Two terminal cases, both correspond to a wake that will do NO model work at
 * all: no operator credential for the org, or a human decision already
 * pending on this conversation (see the long comment that used to live
 * inline here, now on the pending-approval branch below — it explains why
 * this must be checked per-wake with no TTL/auto-deny).
 *
 * A pending-approval skip in particular is not rare or transient: on an org
 * gated on a human decision, EVERY wake hits it, indefinitely, until someone
 * clicks — on the 1-minute timer tick, and now on every event-driven wake
 * too. `runOperatorTurn` calls this same function internally, so there is one
 * implementation of "should this wake even run", not a second copy of the
 * credential/pending logic living in `SandboxRunner` that could drift from
 * this one.
 */
export async function operatorPreflight(
  pool: pg.Pool,
  job: OperatorJob,
): Promise<OperatorPreflight> {
  const credential = await getOperatorCredential(pool, job.organizationId);
  if (!credential) {
    return {
      ok: false,
      result: {
        conversationId: '',
        events: 0,
        approvalId: null,
        error: `no operator credential for org ${job.organizationId}`,
        skipped: null,
      },
    };
  }

  const conversationId = await getOrCreateOperatorConversation(
    pool,
    job.organizationId,
    resolveOperatorModel(),
  );

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
      ok: false,
      result: {
        conversationId,
        events: 0,
        approvalId: null,
        error: null,
        skipped: { reason: 'pending_approval', approvalId: pending[0].id },
      },
    };
  }

  return { ok: true, credential, conversationId };
}

export async function runOperatorTurn(
  pool: pg.Pool,
  opts: {
    job: OperatorJob;
    wake: OperatorWake;
    model?: string;
    /**
     * Executes model-authored code in an isolated sandbox for this turn.
     * Supplied by `SandboxRunner` (cron-scheduler); absent when called from
     * `LocalRunner`, which has no sandbox to offer. Threaded straight through
     * to `runAgentTurn` — see its doc comment for the safety rule this
     * controls (no `codeExecutor` means `run_sandbox_code` is absent from the
     * catalog, never a fallback to host execution).
     */
    codeExecutor?: (code: string) => Promise<{ stdout: string; stderr: string }>;
  },
): Promise<OperatorTurnResult> {
  const { job, wake } = opts;
  const model = resolveOperatorModel(opts.model);

  const pre = await operatorPreflight(pool, job);
  if (!pre.ok) return pre.result;
  const { credential, conversationId } = pre;

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
      codeExecutor: opts.codeExecutor,
    });

    for await (const event of gen) {
      count++;
      if (event.type === 'approval_required') approvalId = event.approval_id;
      if (event.type === 'error') error = event.message;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  /**
   * Make the one failure that kills EVERY wake self-diagnosing.
   *
   * An unroutable model id is not a transient error: it fails identically on
   * every tick, forever, and the operator has no human watching the stream. The
   * gateway names the model it could not find, but nothing in that message says
   * which knob to turn — so name the resolved model and the override here.
   * Purely a message annotation; the wake still fails, and no other outcome
   * (gated / skipped / ran) is touched.
   */
  if (error && /model[_ ]not[_ ]found|Model not found|unknown model/i.test(error)) {
    error =
      `${error} — operator model "${model}" is not routable by this gateway. ` +
      `Model ids are provider-prefixed (e.g. "${DEFAULT_OPERATOR_MODEL}"); ` +
      `check GET /v1/models and set OPERATOR_MODEL to a catalog id.`;
  }

  return { conversationId, events: count, approvalId, error, skipped: null };
}
