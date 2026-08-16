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
 * prevent. A request reads ONE PAGE, and a page is bounded twice over: by the
 * number of turns asked for, and by a message ceiling behind it.
 *
 * ── Why the page is selected from wake messages, not from the transcript ─────
 *
 * The first version read the newest N messages and derived whatever turns fell
 * out, which made the page size a guess: a turn is however many rows the agent
 * happened to write, so "the last 1500 messages" is an unknown number of turns,
 * and the oldest one is nearly always cut off at the head. It was capped at 50
 * turns total with no way to reach turn 51 — the history was simply
 * unreachable.
 *
 * Now the page is chosen from the wake messages alone (one row per turn, so
 * `LIMIT n` means exactly n turns), and the transcript is then fetched for the
 * bounded time range those wakes span. Every returned turn has its head, the
 * cursor walks the whole conversation, and `MAX_MESSAGES` goes back to being
 * what it should always have been: a safety valve, not the pagination.
 */
import type pg from 'pg';

/**
 * Safety valve on the transcript read behind one page. Not the paginator — the
 * page size is chosen from wake rows before this applies. It only trips when a
 * single page's turns are enormous, and when it does the caller is told
 * (`truncated`) rather than silently shown a turn missing its middle.
 */
const MAX_MESSAGES = 1500;
/** Ceiling on turns per page. Pagination, not truncation: use the cursor. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 10;
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

export type OperatorTraceOrder = 'newest' | 'oldest';

export type ListOperatorTracesOptions = {
  /** Turns per page. Clamped to [1, MAX_PAGE_SIZE]. */
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
  /** Only turns that STARTED at or after this instant. */
  since?: Date | null;
  /** Only turns that STARTED at or before this instant. */
  until?: Date | null;
  order?: OperatorTraceOrder;
};

export type OperatorTracePage = {
  traces: OperatorTrace[];
  /** Pass back as `cursor` for the next page. Null when the page is the last. */
  nextCursor: string | null;
  /**
   * True when MAX_MESSAGES cut the transcript read for this page, so some turn
   * on it is missing steps. Surfaced rather than swallowed: a debugging view
   * that quietly drops tool calls teaches the reader the agent did less than
   * it did.
   */
  truncated: boolean;
};

/**
 * A cursor is the position of a wake message in the conversation's total order,
 * which is `(created_at, id)` — `created_at` alone is not unique enough, and
 * two wakes in the same millisecond would make a page repeat or skip forever.
 *
 * Encoded rather than structured so callers treat it as opaque and we stay free
 * to change it. It is not a security boundary: the route resolves the
 * conversation from the caller's own org before this is ever applied, so a
 * forged cursor can only move someone around inside their own transcript.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep <= 0) return null;
    const createdAt = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

type WakeRow = { id: string; created_at: Date };

/**
 * One page of operator turns for `conversationId`.
 *
 * Every turn on the page is complete — the page is selected from wake messages
 * first, then the transcript is read for exactly the range they span, so no
 * turn can lose its head to a window edge.
 *
 * A bad cursor is treated as no cursor (first page) rather than an error: it is
 * a debugging view, and a stale link should show the top of the list instead of
 * a failure.
 */
export async function listOperatorTraces(
  pool: pg.Pool,
  conversationId: string,
  options: ListOperatorTracesOptions = {},
): Promise<OperatorTracePage> {
  const { cursor = null, since = null, until = null, order = 'newest' } = options;
  const pageSize = Math.min(Math.max(1, Math.trunc(options.limit ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);
  const newestFirstOrder = order !== 'oldest';

  // ── 1. Which turns are on this page? ──────────────────────────────────────
  //
  // One row per turn, so LIMIT here means turns. `pageSize + 1` is the
  // has-more probe: if the extra row comes back there is another page, and it
  // is dropped before the transcript read so it costs nothing but a row.
  const where: string[] = ['conversation_id = $1', "role = 'user'"];
  const params: unknown[] = [conversationId];

  if (since) {
    params.push(since);
    where.push(`created_at >= $${params.length}`);
  }
  if (until) {
    params.push(until);
    where.push(`created_at <= $${params.length}`);
  }

  const decoded = cursor ? decodeCursor(cursor) : null;
  if (decoded) {
    // Row-value comparison against the same tuple the ORDER BY uses, so the
    // boundary is exact whichever direction we are walking.
    params.push(decoded.createdAt, decoded.id);
    const cmp = newestFirstOrder ? '<' : '>';
    where.push(`(created_at, id) ${cmp} ($${params.length - 1}, $${params.length})`);
  }

  const dir = newestFirstOrder ? 'DESC' : 'ASC';
  params.push(pageSize + 1);

  const { rows: wakeRows } = await pool.query<WakeRow>(
    `SELECT id, created_at
       FROM dashboard_agent_messages
      WHERE ${where.join(' AND ')}
      ORDER BY created_at ${dir}, id ${dir}
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = wakeRows.length > pageSize;
  const pageWakes = hasMore ? wakeRows.slice(0, pageSize) : wakeRows;
  if (pageWakes.length === 0) return { traces: [], nextCursor: null, truncated: false };

  const lastWake = pageWakes[pageWakes.length - 1];
  const nextCursor = hasMore ? encodeCursor(lastWake.created_at, lastWake.id) : null;

  // ── 2. The transcript for exactly the range those wakes span ──────────────
  //
  // Lower bound is the page's earliest wake, inclusive. The upper bound is
  // EXCLUSIVE of the wake that opens the next turn — without it the read would
  // run to the end of the conversation and pull in every later turn's steps,
  // which the derivation below would then hang off the last turn on this page.
  const earliest = newestFirstOrder ? lastWake : pageWakes[0];
  const latestWake = newestFirstOrder ? pageWakes[0] : lastWake;

  const nextTurnStart = await pool.query<WakeRow>(
    `SELECT id, created_at
       FROM dashboard_agent_messages
      WHERE conversation_id = $1 AND role = 'user'
        AND (created_at, id) > ($2, $3)
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [conversationId, latestWake.created_at, latestWake.id],
  );

  const transcriptParams: unknown[] = [conversationId, earliest.created_at, earliest.id];
  let upperBound = '';
  if (nextTurnStart.rows.length > 0) {
    const stop = nextTurnStart.rows[0];
    transcriptParams.push(stop.created_at, stop.id);
    upperBound = ` AND (created_at, id) < ($4, $5)`;
  }
  transcriptParams.push(MAX_MESSAGES + 1);

  const { rows } = await pool.query<Row>(
    `SELECT id, role, content, tool_name, tool_args, tool_result,
            model_used, pending_approval_id, created_at
       FROM dashboard_agent_messages
      WHERE conversation_id = $1
        AND (created_at, id) >= ($2, $3)${upperBound}
      ORDER BY created_at ASC, id ASC
      LIMIT $${transcriptParams.length}`,
    transcriptParams,
  );

  // Read one more than the ceiling so a full read is distinguishable from one
  // that was cut. Chronological already — no reverse.
  const truncated = rows.length > MAX_MESSAGES;
  const chronological = truncated ? rows.slice(0, MAX_MESSAGES) : rows;

  // Split on the wake message. The first row IS a wake by construction, so
  // unlike the previous implementation there is no head-truncated remnant.
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

  // Derived chronologically; the caller's order decides which way it reads.
  // No slice — the page size was settled by the wake query, and cutting here
  // again is what made turn 51 unreachable.
  const ordered = newestFirstOrder ? turns.reverse() : turns;

  // Attach approvals. A gated turn's assistant row carries the approval id;
  // the approval itself holds the resolution a later click wrote.
  const approvalIds = ordered
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
    for (const turn of ordered) {
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

  return { traces: ordered, nextCursor, truncated };
}
