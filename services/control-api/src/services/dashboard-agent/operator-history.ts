import type { Message } from './store.js';

/**
 * ============================================================================
 * I2 — bound what an OPERATOR turn replays to the gateway.
 *
 * There is exactly one operator conversation per org and it is reused forever.
 * `listMessages` has no LIMIT, so before this module every wake replayed the
 * entire accumulated transcript. At the default 600s job interval that is ~144
 * wakes/day against a monotonically growing history: a scheduled
 * context-window failure, and a materially growing bill on the way to it.
 *
 * This is safe to do NOW and was not before, because continuity no longer has
 * to live in the transcript: the per-org scratchpad (agent-authored, read into
 * the wake message for free, capped at OPERATOR_SCRATCHPAD_MAX_CHARS) plus the
 * platform-authored wake header carry what a trimmed transcript would drop.
 *
 * NOTHING IS DELETED. This decides what is REPLAYED. Every row stays in
 * `dashboard_agent_messages` for audit and for the approvals path.
 *
 * OPERATOR-ONLY. `loop.ts` calls this behind `isOperator`; for a human
 * conversation the array handed to `toGatewayMessages` is the same object
 * `listMessages` returned, by identity.
 *
 * ---------------------------------------------------------------------------
 * THE WAY TO GET THIS CATASTROPHICALLY WRONG — read before touching the cut.
 *
 * The gateway REJECTS any history in which an assistant `tool_calls` message
 * has no matching `role:'tool'` result (see resume.ts's header). This branch
 * has already had to fix that exact wedge twice, because one conversation per
 * org means a single invalid history bricks that org's operator permanently —
 * every wake, forever, with no recovery short of manual DB surgery.
 *
 * A naive "keep the last N messages" cut lands BETWEEN an assistant
 * `tool_calls` row and its `role:'tool'` result and reproduces that wedge on a
 * timer. So the cut here is not chosen by counting backwards. It is chosen from
 * the set of PAIRING-VALID cut points, computed first:
 *
 *   - a linked pair (assistant at index a, tool result at index t) forbids
 *     every cut in (a, t] — those keep the result and drop the call;
 *   - a `role:'tool'` row with no assistant call anywhere before it (already
 *     invalid, however it got there) forbids every cut <= t, so trimming
 *     removes it rather than forwarding it;
 *   - an assistant `tool_calls` row with no matching result forbids every cut
 *     <= a, for the same reason and in the other direction.
 *
 * The consequence is a total guarantee rather than a probabilistic one: the
 * emitted slice can never contain an orphan in either direction, whatever the
 * budget is set to and whatever shape the stored history has.
 * ============================================================================
 */

/**
 * Character budget for the REPLAYED history, measured against what
 * `toGatewayMessages` will actually serialize (see `replayCost`).
 *
 * Sizing, deliberately conservative rather than generous:
 *
 *   - the wake message is persisted BEFORE `listMessages` runs, so it is always
 *     the last row and always inside this budget. It can now carry up to
 *     OPERATOR_SCRATCHPAD_MAX_CHARS (8000) of scratchpad plus the header plus
 *     the job instructions — call it ~10k characters on a full scratchpad. That
 *     is a meaningful share of this number, not a rounding error;
 *   - ~32k characters is roughly 8k tokens. At 144 wakes/day that is a bounded,
 *     predictable ceiling instead of an unbounded ramp;
 *   - the scratchpad, not the transcript, is where continuity is supposed to
 *     live. A large history budget would quietly re-create the dependency this
 *     design is trying to remove.
 *
 * The budget is a CEILING, not a floor: the minimal pairing-valid non-empty
 * suffix is always replayed even if it exceeds this (see `trimOperatorHistory`),
 * because dropping the wake message itself would be worse than being over.
 */
export const OPERATOR_HISTORY_MAX_CHARS = 32_000;

/**
 * Secondary ceiling on message COUNT. The character budget is the real bound;
 * this one exists because many tiny rows (tool errors, one-word assistant
 * turns) cost per-message envelope overhead the character count understates.
 */
export const OPERATOR_HISTORY_MAX_MESSAGES = 40;

/** Rough per-message JSON envelope overhead (role/keys/braces/commas). */
const MESSAGE_ENVELOPE_CHARS = 24;

/**
 * Cost of a stored row as the gateway will see it. Mirrors `toGatewayMessages`
 * in loop.ts branch for branch — if that function changes shape, change this.
 */
export function replayCost(msg: Message): number {
  if (msg.role === 'tool') {
    return (
      MESSAGE_ENVELOPE_CHARS +
      (msg.toolCallId?.length ?? 0) +
      JSON.stringify(msg.toolResult ?? {}).length
    );
  }
  if (msg.role === 'assistant' && msg.toolCallId) {
    return (
      MESSAGE_ENVELOPE_CHARS +
      (msg.content?.length ?? 0) +
      msg.toolCallId.length +
      (msg.toolName?.length ?? 0) +
      JSON.stringify(msg.toolArgs ?? {}).length
    );
  }
  return MESSAGE_ENVELOPE_CHARS + (msg.content?.length ?? 0);
}

/**
 * Cut points that would emit a pairing-invalid history.
 *
 * `invalid[i] === true` means "keeping `messages.slice(i)` breaks a
 * call/result pairing". Index range is [0, n]; `n` is the empty suffix.
 */
function invalidCutPoints(messages: Message[]): boolean[] {
  const n = messages.length;
  const invalid = new Array<boolean>(n + 1).fill(false);

  // First assistant row that issues each tool_call_id, and first tool row that
  // answers it. Duplicates cannot occur (tool_call ids are per-turn unique) but
  // taking the first is stable either way.
  const callIndexById = new Map<string, number>();
  const resultIndexById = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const m = messages[i];
    if (m.role === 'tool') {
      const id = m.toolCallId ?? '';
      if (!resultIndexById.has(id)) resultIndexById.set(id, i);
    } else if (m.role === 'assistant' && m.toolCallId) {
      if (!callIndexById.has(m.toolCallId)) callIndexById.set(m.toolCallId, i);
    }
  }

  const forbidUpTo = (last: number) => {
    for (let i = 0; i <= last && i <= n; i++) invalid[i] = true;
  };

  // Tool results: forbid cuts that would keep the result without its call.
  for (const [id, t] of resultIndexById) {
    const a = callIndexById.get(id);
    if (a === undefined || a > t) {
      // Orphan (or out-of-order) result. Already invalid as stored; the only
      // safe slice is one that starts after it.
      forbidUpTo(t);
      continue;
    }
    for (let i = a + 1; i <= t; i++) invalid[i] = true;
  }

  // Assistant tool_calls with no result: the mirror case. Forbid every cut that
  // would keep it, so trimming drops the unanswered call instead of forwarding
  // the exact sequence the gateway rejects.
  for (const [id, a] of callIndexById) {
    const t = resultIndexById.get(id);
    if (t === undefined || t < a) forbidUpTo(a);
  }

  return invalid;
}

/**
 * Bound an operator conversation's replayed history.
 *
 * Returns a SUFFIX of `messages` (most recent rows), chosen as the EARLIEST
 * pairing-valid cut point whose suffix fits both budgets — i.e. the most
 * history that fits without breaking a pairing. If no valid cut fits, the
 * minimal non-empty pairing-valid suffix is returned instead: being over
 * budget is recoverable, replaying nothing (and so dropping the wake message
 * the model is supposed to answer) is not.
 *
 * Never mutates its input and never touches the database.
 */
export function trimOperatorHistory(
  messages: Message[],
  opts?: { maxChars?: number; maxMessages?: number },
): Message[] {
  const n = messages.length;
  if (n === 0) return messages;

  const maxChars = opts?.maxChars ?? OPERATOR_HISTORY_MAX_CHARS;
  const maxMessages = opts?.maxMessages ?? OPERATOR_HISTORY_MAX_MESSAGES;

  const invalid = invalidCutPoints(messages);

  // suffixChars[i] = replay cost of messages.slice(i)
  const suffixChars = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    suffixChars[i] = suffixChars[i + 1] + replayCost(messages[i]);
  }

  /**
   * Earliest valid cut that fits both budgets => the most history we can keep.
   *
   * `i < n`, not `i <= n`: the empty suffix trivially "fits" every budget, and
   * accepting it would drop the wake message the model is being asked to
   * answer. An over-budget non-empty suffix is the correct answer there, and
   * the fallback below supplies it.
   */
  for (let i = 0; i < n; i++) {
    if (invalid[i]) continue;
    if (suffixChars[i] <= maxChars && n - i <= maxMessages) {
      return i === 0 ? messages : messages.slice(i);
    }
  }

  // Nothing fits. Fall back to the smallest non-empty valid suffix.
  for (let i = n - 1; i >= 0; i--) {
    if (!invalid[i]) return messages.slice(i);
  }

  /**
   * No non-empty valid suffix exists at all. Only reachable from a history that
   * is already invalid at its final row (e.g. it ends in an orphan tool
   * result) — which an operator turn cannot produce, because `runAgentTurn`
   * persists the wake `role:'user'` message before reading history. Return the
   * input unchanged rather than inventing a repair: trimming's job is to bound
   * a valid history, not to fix a broken one.
   */
  return messages;
}
