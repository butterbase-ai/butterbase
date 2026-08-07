import pg from 'pg';
import { randomUUID } from 'crypto';
import { runAgentTurn } from './loop.js';
import { getOrCreateOperatorConversation, operatorUserId, type OperatorJob } from './operator-store.js';
import { getOperatorCredential } from './operator-credential.js';
import { listPendingByConv, findResumableApproval, markApprovalResumed } from './approvals-store.js';
import {
  getOperatorScratchpad,
  OPERATOR_SCRATCHPAD_MAX_CHARS,
  type OperatorScratchpad,
} from './operator-scratchpad-store.js';
import { OPERATOR_SCRATCHPAD_TOOL } from './tool-catalog.js';

/**
 * ============================================================================
 * DISTRIBUTED TRACE ID (Task D1)
 * ============================================================================
 *
 * There was no distributed trace id anywhere in this codebase before this
 * task — correlation across the operator chain was by `run_id`/`app_id`/
 * `build_id` only, which does not identify one wake's worth of work end to
 * end.
 *
 * FORMAT: `optr_<uuid v4>`, minted with `crypto.randomUUID()` at the wake
 * (cron-scheduler's `operator-trigger.ts` for the timer path,
 * `operator-events.ts` for the event path — see those files). A bare UUID
 * would work equally well for uniqueness; the `optr_` prefix exists purely so
 * the id is self-describing when it shows up alone in a log line, a bug
 * report, or (per the cross-cloud note below) an Alibaba SLS record next to
 * unrelated ids — there being no existing trace-id convention in this
 * codebase to match, this one is free to pick, and "greppable origin" was
 * judged more useful than "matches nothing else" (there is nothing else).
 *
 * BOUNDARY THIS ID DOES NOT CROSS: code executed inside an E2B/Alibaba-FC
 * sandbox (`run_sandbox_code`) runs guest-side and returns stdout over HTTP;
 * it never touches the sandbox container's own stdout, so anything the
 * MODEL's sandboxed code might `print()` — including this trace id — never
 * reaches Alibaba's SLS log pipeline. This is a verified platform boundary,
 * not a gap in this implementation, and no propagation into guest code is
 * attempted. What DOES cross clouds is the sandbox id itself
 * (`SandboxHandle.id` from `sandbox-provider.ts`): cron-scheduler logs it
 * alongside the trace id whenever `SandboxRunner` creates or kills a sandbox
 * (see operator-runner.ts), which is enough to join "this trace id" to "this
 * Alibaba sandbox" without any guest-side cooperation.
 *
 * PERSISTENCE ACROSS THE GATE: `dashboard_agent_approvals.trace_id` (added by
 * 098_operator_trace_id.sql / 006_operator_trace_id.sql) stores the trace id
 * of the turn that created the approval. `findResumableApproval` /
 * `markApprovalResumed` below are what let a LATER wake — one that finds the
 * gate cleared — report that same id instead of the fresh one its own wake
 * minted. See `resolveTurnTraceId`.
 * ============================================================================
 */
/**
 * `completed` is not one of the plan's five named checkpoints
 * (woke/planned/acted/gated/resumed) — it was added after review found that a
 * turn's START is traceable but its END was not: neither of the two
 * pre-existing completion logs (`[operator-events]`'s per-org result line,
 * cron-scheduler's per-batch `[operator-trigger]` summary) carried a trace
 * id, and `runOperatorTurn`'s error path logged no traced line at all. A wake
 * that `operatorPreflight` skips for `pending_approval` emitted `woke` and
 * then NOTHING — indistinguishable in the logs from a turn that hung or
 * crashed the process. `completed` closes every exit path of
 * `runOperatorTurn`, including both `operatorPreflight` failure branches, so
 * every `woke` has a matching terminal line under the same trace id.
 */
export type OperatorCheckpoint = 'woke' | 'planned' | 'acted' | 'gated' | 'resumed' | 'completed';

/**
 * One structured log line per checkpoint, always carrying the trace id.
 *
 * Emitted as a single JSON line (not the `console.log(tag, obj)` shape used
 * elsewhere in this codebase) so it can be ingested as structured data
 * without a prefix to strip first — the `log` field plays the role the
 * bracketed tag plays elsewhere, and `checkpoint`/`traceId` are queryable
 * fields rather than substrings of a formatted object dump.
 *
 * Deliberately takes only plain, non-sensitive fields (org id, job name,
 * conversation id, approval id, sandbox id, tool NAME, event counts) — never
 * tool arguments and never a credential. See the "no tool args" rule in
 * tool-catalog.ts's operator-catalog logging; the same line is held here.
 */
export function logOperatorCheckpoint(
  checkpoint: OperatorCheckpoint,
  fields: Record<string, string | number | boolean | null | undefined>,
): void {
  console.log(JSON.stringify({ log: 'operator-trace', checkpoint, ts: new Date().toISOString(), ...fields }));
}

export type OperatorWake =
  | { reason: 'timer'; traceId?: string }
  | { reason: 'event'; table: string; rowId: string; traceId?: string };

/**
 * `traceId` on `OperatorWake` is OPTIONAL in the type, not because a wake is
 * ever meant to arrive without one — both cron-scheduler dispatch sites
 * (`operator-trigger.ts`'s timer loop, `operator-events.ts`'s event drain)
 * always mint one before calling the runner — but because dozens of existing
 * unit tests construct `OperatorWake` literals by hand
 * (`{ reason: 'timer' }`) and requiring the field on the type would force a
 * mechanical, low-value edit across every one of them for a field those tests
 * are not exercising. Falling back to a freshly minted id here, rather than
 * throwing or leaving the field empty, keeps `runOperatorTurn` itself
 * correct — every turn reports SOME trace id — even when called from a
 * context (a test, a future caller) that did not supply one.
 */
function mintFallbackTraceId(): string {
  return `optr_${randomUUID()}`;
}

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
export const OPERATOR_WAKE_PROMPT_VERSION = 'operator-wake/2026-08-07.1';

/**
 * `source_artifact_id` is documented on record_learning, record_decision and
 * record_commitment — "set when this learning was extracted from a meeting
 * transcript, email, etc." — and the agent ignores it. Measured 2026-08-07:
 * 1 of 25 learnings and 2 of 111 decisions carry one; commitments, which the
 * agent does fill, sit at 7 of 8.
 *
 * That gap is a prompting problem, not a schema one. The field exists, the
 * schema describes it, and nothing tells the agent it matters — the same shape
 * as the file-memos-instead-of-acting defect. So say it here, in the wake
 * envelope, which reaches every job rather than only newly seeded ones.
 */
const PROVENANCE_INSTRUCTION =
  'When you record a learning, decision or commitment that came from something you read — a call transcript, an email, a support ticket — set `source_artifact_id` to that artifact. An observation with no source cannot be checked by the person relying on it, and the owner sees these in their feed. If you read something that is not yet an artifact, record it with `upsert_source_artifact` first and cite the id it returns.';

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
/** Exported so a live sweep can put the *real* wake message in front of a real
 *  model. Whether the agent fills an optional field is not something a mocked
 *  test can answer, and a paraphrased prompt would not answer it either. */
export function buildWakeMessage(
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
    PROVENANCE_INSTRUCTION,
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
  | {
      ok: true;
      credential: string;
      conversationId: string;
      /**
       * The trace id THIS turn must report — not necessarily `wake.traceId`.
       * See `resolveTurnTraceId`: when this wake is resuming a conversation
       * that gated on a human approval, this is the PERSISTED id from that
       * approval row, and `wake.traceId` (freshly minted for this wake) is
       * discarded in favour of it.
       */
      traceId: string;
      /** Set only when `traceId` was carried forward from a resumed approval. */
      resumedApprovalId: string | null;
    }
  | { ok: false; result: OperatorTurnResult };

/**
 * Decide which trace id this turn WOULD report: the one freshly minted for
 * this wake, or — when this wake is resuming a conversation that gated on a
 * human approval — the id persisted on that approval row.
 *
 * "Resuming" is detected structurally, not by a flag the caller supplies:
 * `findResumableApproval` looks for the most recent RESOLVED approval on this
 * conversation that carries a trace id and has not already been consumed by
 * an earlier resume (`resumed_at IS NULL`). If one exists, this wake IS the
 * resume — `runOperatorTurn` refuses to start any turn while an approval is
 * still pending (see the pending-approval branch above), so the only way a
 * resolved-but-unconsumed approval can exist when a turn is about to run is
 * that a human clicked since the last wake and this is the first wake to see
 * the cleared gate.
 *
 * DELIBERATELY A PURE READ — no mark, no log. `operatorPreflight` is called
 * TWICE per turn on the `SandboxRunner` path (once by `SandboxRunner` itself
 * to decide whether to pay for a sandbox, once more inside `runOperatorTurn`
 * — see the "two cheap reads" note on `operatorPreflight`'s own doc comment).
 * If this function committed `resumed_at` on the first call, the SECOND call
 * would find nothing resumable and silently fall back to the freshly minted
 * id — the exact continuity bug this task exists to prevent, self-inflicted
 * by the duplication. Keeping this a pure peek means both calls agree, and
 * the actual commit (`markApprovalResumed`) plus the `resumed` checkpoint log
 * happen exactly once, in `runOperatorTurn`, the one call site that is
 * guaranteed to run only once per turn regardless of which runner is active.
 */
async function resolveTurnTraceId(
  pool: pg.Pool,
  conversationId: string,
  mintedTraceId: string,
): Promise<{ traceId: string; resumedApprovalId: string | null }> {
  const resumable = await findResumableApproval(pool, conversationId);
  if (!resumable || !resumable.traceId) return { traceId: mintedTraceId, resumedApprovalId: null };
  return { traceId: resumable.traceId, resumedApprovalId: resumable.id };
}

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
 *
 * `model` is passed straight to `resolveOperatorModel`, exactly as
 * `runOperatorTurn` does with its own `opts.model` — it is only CONSULTED
 * here when `getOrCreateOperatorConversation` creates the row for the first
 * time (the column is write-once-on-create), but it must be the same value
 * `runOperatorTurn` resolves for the same call, or the row can record a
 * different model than the turn that follows actually runs on. That
 * mismatch already cost this project once, in a different shape (Plan 1
 * shipped an unroutable default id past every mocked test) — a conversation
 * row lying about which model ran is the same failure mode in miniature, and
 * it would mislead exactly the debugging session that needs it most.
 */
export async function operatorPreflight(
  pool: pg.Pool,
  job: OperatorJob,
  wake: OperatorWake,
  model?: string,
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
    resolveOperatorModel(model),
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

  // See `resolveTurnTraceId`'s doc comment: reaching here means no approval
  // is pending, so if a resolved-but-unconsumed one exists on this
  // conversation, THIS is the wake that resumes it. A PURE PEEK — see that
  // function's comment for why the commit (`markApprovalResumed`) and the
  // `resumed` checkpoint log must NOT happen here, where this function's own
  // "called twice per turn" contract would fire them twice (or worse, have
  // the second call silently lose the resumed id to the first call's mark).
  const { traceId, resumedApprovalId } = await resolveTurnTraceId(
    pool,
    conversationId,
    wake.traceId ?? mintFallbackTraceId(),
  );

  return { ok: true, credential, conversationId, traceId, resumedApprovalId };
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

  const pre = await operatorPreflight(pool, job, wake, opts.model);
  if (!pre.ok) {
    // `wake.traceId`, not a resolved one: `operatorPreflight` bails before
    // `resolveTurnTraceId` ever runs on both its failure branches (no
    // credential; a human decision still pending), so there is nothing to
    // resolve — this wake did no resuming, it just didn't proceed. Best
    // effort if the caller supplied no id at all (see `OperatorWake`'s doc
    // comment on why that field is optional).
    logOperatorCheckpoint('completed', {
      traceId: wake.traceId ?? null,
      organizationId: job.organizationId,
      conversationId: pre.result.conversationId || null,
      outcome: pre.result.skipped ? 'skipped' : 'error',
      skippedReason: pre.result.skipped?.reason ?? null,
      error: pre.result.error,
    });
    return pre.result;
  }
  const { credential, conversationId, traceId } = pre;

  /**
   * THE ONE PLACE the resume is committed and logged. `runOperatorTurn` is
   * the single call site guaranteed to run once per actual turn, whichever
   * runner (`LocalRunner` or `SandboxRunner`) got here — `SandboxRunner`'s
   * own earlier `operatorPreflight` call (used only to decide whether to pay
   * for a sandbox) reads the same resumable approval but never marks or logs
   * it. See `resolveTurnTraceId`'s doc comment.
   */
  if (pre.resumedApprovalId) {
    await markApprovalResumed(pool, pre.resumedApprovalId);
    logOperatorCheckpoint('resumed', {
      traceId,
      organizationId: job.organizationId,
      conversationId,
      approvalId: pre.resumedApprovalId,
      mintedTraceId: wake.traceId,
    });
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

  /**
   * `planned` — the turn has everything it needs (credential, conversation,
   * scratchpad, the resolved trace id) and is about to hand the wake message
   * to the model. This is NOT `pre.resumedApprovalId ? 'resumed' : 'planned'`
   * as an either/or: `resumed` (logged just above, in THIS function — not
   * inside `operatorPreflight`, see the "ONE PLACE" comment on that block for
   * why the commit had to move here) marks the fact that this wake is
   * continuing a gated conversation; `planned` marks every turn's model
   * dispatch regardless, resumed or not, so a resumed turn's timeline reads
   * `resumed -> planned -> ...` rather than `resumed` standing in for the
   * model actually being asked to act.
   */
  logOperatorCheckpoint('planned', {
    traceId,
    organizationId: job.organizationId,
    conversationId,
    jobName: job.name,
    wakeReason: wake.reason,
  });

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
      traceId,
      // Until now, job name and wake reason existed only as prose inside the
      // wake message — in the model's context window, in no structured field.
      // The ledger recorded every one of these as triggered_by
      // 'user_instruction', which for an unattended 3am tick is false.
      triggerContext: {
        source: 'operator_wake',
        job: job.name,
        wake_reason:
          wake.reason === 'timer' ? 'timer' : `event (${wake.table} row ${wake.rowId})`,
        trace_id: traceId,
      },
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

  // `completed` — the terminal checkpoint for a turn that actually reached
  // the model, closing the timeline `woke`/`resumed` -> `planned` -> `acted`?
  // -> `gated`? opened. Carries the RESOLVED `traceId` (post-resume, if this
  // was a resume), not `wake.traceId` — this is the id a reader must match
  // back to the `woke`/`resumed` line that started this same turn.
  logOperatorCheckpoint('completed', {
    traceId,
    organizationId: job.organizationId,
    conversationId,
    events: count,
    gated: !!approvalId,
    error,
  });

  return { conversationId, events: count, approvalId, error, skipped: null };
}
