/**
 * TEMPORARY — operator turn traces for the dev-mode trace viewer.
 *
 * Added 2026-08-07 at the operator's request for a place to WATCH what the
 * agent did, now that it reaches the whole tool catalog rather than six tools.
 * Read-only, dev-mode gated in the UI. Delete this module, its route, and
 * `features/operator-traces` in the dashboard together when it stops earning
 * its keep — it has no other callers.
 *
 * ── Why turns are derived, not stored ────────────────────────────────────────
 *
 * There is no `trace_id` on `dashboard_agent_messages`. The distributed trace
 * id (D1) is minted per wake and appears in the `operator-trace` LOG
 * checkpoints and on `dashboard_agent_approvals.trace_id`, but it was never
 * persisted per message — so it cannot group a transcript after the fact.
 *
 * Rather than add a column and a migration in both streams for a temporary
 * debugging view, turns are derived from a property the transcript already
 * guarantees: `runAgentTurn` appends exactly ONE `role:'user'` row per wake
 * (the platform-authored wake envelope) before anything else. So every
 * `role:'user'` row opens a turn and the next one closes it. That is the same
 * boundary `operator-history.ts` reasons about, and it needs no schema change.
 *
 * If a turn ever needs to be joined to its log lines by trace id, the honest
 * fix is a `trace_id` column on the message table — not a heuristic here.
 *
 * ── Bounded by construction ──────────────────────────────────────────────────
 *
 * One operator conversation per org is reused FOREVER, so an unbounded read of
 * this table is the same scheduled failure `operator-history.ts` exists to
 * prevent. Rows are fetched newest-first with a hard cap, then reversed —
 * never `SELECT *` over the conversation.
 */
import type pg from 'pg';

/** Hard ceiling on messages read per request, whatever the caller asks for. */
const MAX_MESSAGES = 1500;
/** Hard ceiling on turns returned. */
const MAX_TURNS = 50;
/** Tool args/results are for eyeballing, not archaeology — cap the payloads. */
const MAX_PAYLOAD_CHARS = 4000;

export type OperatorTraceStep = {
  id: string;
  role: 'assistant' | 'tool';
  toolName: string | null;
  toolArgs: string | null;
  toolResult: string | null;
  /** True when the result payload is an error envelope (refusal, MCP error). */
  isError: boolean;
  content: string;
  pendingApprovalId: string | null;
  createdAt: string;
};

export type OperatorTrace = {
  /** The wake message's id — stable, and unique per turn. */
  turnId: string;
  startedAt: string;
  endedAt: string;
  /** The platform-authored wake envelope, verbatim. */
  wake: string;
  model: string | null;
  steps: OperatorTraceStep[];
  /** Distinct tools this turn actually called, in first-use order. */
  toolsUsed: string[];
  /** Set when the turn paused on a gate. */
  approval: {
    id: string;
    toolName: string;
    status: string;
    traceId: string | null;
    denyReason: string | null;
    resolvedAt: string | null;
  } | null;
  /** The assistant's closing text, when the turn ran to completion. */
  finalText: string;
};

function clamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return null;
  return text.length > MAX_PAYLOAD_CHARS
    ? `${text.slice(0, MAX_PAYLOAD_CHARS)}\n…[truncated, ${text.length - MAX_PAYLOAD_CHARS} more chars]`
    : text;
}

/**
 * Did this tool call fail?
 *
 * An error is reported to the model as a tool RESULT, not thrown, so there are
 * exactly two shapes and both are STRUCTURAL:
 *
 *   - `{error: "…"}`     — the loop's own refusals (policy deny, catalog miss)
 *   - `{..., isError: true}` — MCP's own failure flag on its content envelope
 *
 * DO NOT go back to scanning the response TEXT for /error/. The first version
 * of this did, and it flagged a perfectly successful `list_outbox` because the
 * outbox rows it returned each carry a `last_error` FIELD — the substring
 * matched the field name, and the viewer reported "1 error" on a turn that had
 * none. Any payload is free to contain the word "error" as data; only the
 * envelope can say whether the CALL failed.
 */
function looksLikeError(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  return typeof r.error === 'string' || r.isError === true;
}

type Row = {
  id: string;
  role: string;
  content: string;
  tool_name: string | null;
  tool_args: unknown;
  tool_result: unknown;
  model_used: string | null;
  pending_approval_id: string | null;
  created_at: Date;
};

type ApprovalRow = {
  id: string;
  tool_name: string;
  status: string;
  trace_id: string | null;
  deny_reason: string | null;
  resolved_at: Date | null;
};

/**
 * Most recent operator turns for `conversationId`, newest turn first.
 *
 * The message read is newest-first + capped, so the OLDEST turn in the window
 * is very likely truncated at its head. It is dropped rather than shown as a
 * turn with no wake message — a half-turn in a debugging view is worse than
 * one fewer turn, because it looks like the agent did less than it did.
 */
export async function listOperatorTraces(
  pool: pg.Pool,
  conversationId: string,
  limit = 10,
): Promise<OperatorTrace[]> {
  const turnLimit = Math.min(Math.max(1, limit), MAX_TURNS);

  const { rows } = await pool.query<Row>(
    `SELECT id, role, content, tool_name, tool_args, tool_result,
            model_used, pending_approval_id, created_at
       FROM dashboard_agent_messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [conversationId, MAX_MESSAGES],
  );
  if (rows.length === 0) return [];

  const chronological = rows.slice().reverse();

  // Split on the wake message. Anything before the first one belongs to a turn
  // whose head fell outside the window — see the doc comment.
  const turns: OperatorTrace[] = [];
  for (const row of chronological) {
    if (row.role === 'user') {
      turns.push({
        turnId: row.id,
        startedAt: row.created_at.toISOString(),
        endedAt: row.created_at.toISOString(),
        wake: row.content,
        model: row.model_used,
        steps: [],
        toolsUsed: [],
        approval: null,
        finalText: '',
      });
      continue;
    }
    const turn = turns[turns.length - 1];
    if (!turn) continue; // pre-window remnant
    if (row.role !== 'assistant' && row.role !== 'tool') continue;

    turn.endedAt = row.created_at.toISOString();
    if (row.role === 'assistant' && !row.tool_name && row.content.trim()) {
      turn.finalText = row.content;
    }
    if (row.tool_name && !turn.toolsUsed.includes(row.tool_name)) {
      turn.toolsUsed.push(row.tool_name);
    }
    turn.steps.push({
      id: row.id,
      role: row.role,
      toolName: row.tool_name,
      toolArgs: clamp(row.tool_args),
      toolResult: clamp(row.tool_result),
      isError: row.role === 'tool' && looksLikeError(row.tool_result),
      content: row.content,
      pendingApprovalId: row.pending_approval_id,
      createdAt: row.created_at.toISOString(),
    });
  }

  const newestFirst = turns.reverse().slice(0, turnLimit);

  // Attach approvals. A gated turn's assistant row carries the approval id;
  // the approval itself holds the resolution a later click wrote.
  const approvalIds = newestFirst
    .flatMap((t) => t.steps.map((s) => s.pendingApprovalId))
    .filter((v): v is string => typeof v === 'string');

  if (approvalIds.length > 0) {
    const { rows: approvals } = await pool.query<ApprovalRow>(
      `SELECT id, tool_name, status, trace_id, deny_reason, resolved_at
         FROM dashboard_agent_approvals
        WHERE id = ANY($1::uuid[])`,
      [approvalIds],
    );
    const byId = new Map(approvals.map((a) => [a.id, a]));
    for (const turn of newestFirst) {
      const gatedStep = turn.steps.find((s) => s.pendingApprovalId);
      const found = gatedStep?.pendingApprovalId ? byId.get(gatedStep.pendingApprovalId) : undefined;
      if (found) {
        turn.approval = {
          id: found.id,
          toolName: found.tool_name,
          status: found.status,
          traceId: found.trace_id,
          denyReason: found.deny_reason,
          resolvedAt: found.resolved_at ? found.resolved_at.toISOString() : null,
        };
      }
    }
  }

  return newestFirst;
}
