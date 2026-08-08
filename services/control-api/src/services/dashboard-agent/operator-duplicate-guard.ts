import { createHash } from 'crypto';

/**
 * ============================================================================
 * LAYER 1 — THE HARD RE-PROPOSAL GUARD (pure half).
 * ============================================================================
 *
 * WHY THIS EXISTS. Until 2026-08-08 a pending approval SKIPPED the whole wake:
 * the operator could not re-propose anything because it could not do anything.
 * That is now gone (see `operatorPreflight` in operator-turn.ts) so that an
 * owner's overnight decision no longer costs ten hours of work. The cost of
 * removing the skip is precisely this: an operator that wakes every minute can
 * propose the same email sixty times before breakfast.
 *
 * THREE LAYERS, and this is the only one that does not depend on the model:
 *   1. this guard, which REFUSES an equivalent proposal in code;
 *   2. a line of turn context listing what is already waiting (operator-turn.ts);
 *   3. `list_pending_decisions`, a local tool for the detail (tool-catalog.ts).
 * Layers 2 and 3 make the agent behave better. Layer 1 is what holds when it
 * does not. This repo has twice watched an optional affordance be ignored —
 * `source_artifact_id` was set 1 time in 25 while fully documented, and the
 * operator filed memos instead of acting for the same reason — so the code
 * that refuses is not the redundant one.
 *
 * ----------------------------------------------------------------------------
 * WHAT "EQUIVALENT" MEANS. Two fingerprints, deliberately, because one alone is
 * wrong in a different direction.
 *
 *  - EXACT: sha256 over (tool name, fully canonicalised args). Catches the
 *    literal replay — the same tool with the same arguments — with ZERO false
 *    positives. A deterministic model re-reading the same substrate state
 *    produces exactly this, which is the common case of the flood.
 *
 *  - TARGET: the same hash with a small, explicit set of TOP-LEVEL free-text
 *    keys removed (`VOLATILE_ARG_KEYS`). Catches the same action, aimed at the
 *    same target, with the prose rewritten — a model that re-derives "email Bob
 *    about the unpaid invoice" will rarely word it identically twice, so the
 *    exact hash alone would let the flood through.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *
 *  - It does not strip nested keys. `{tables:[{description: ...}]}` still
 *    discriminates. Stripping at depth would collapse genuinely different
 *    schema changes, deploys and function bodies into one "decision", and a
 *    guard that blocks real work is worse than the flood it prevents. The
 *    top-level-only rule is what bounds the blast radius to argument shapes
 *    where a free-text key really is the message and everything else really is
 *    the target.
 *  - It does not attempt semantic similarity. Two differently-targeted actions
 *    are two decisions, full stop; the owner is entitled to see both.
 *  - It NEVER expires anything. Nothing here has a TTL and nothing here denies
 *    on the owner's behalf — it refuses the operator's DUPLICATE, leaving the
 *    original decision exactly as the owner left it.
 * ============================================================================
 */

/** A pending decision, flattened to the call the owner is actually deciding on. */
export type PendingGatedCall = {
  approvalId: string;
  /** The tool of the GATED CALL — not necessarily the approval row's own tool
   *  name. A substrate-escalated approval stores `manage_substrate approve`
   *  while the call the owner is deciding on is the original propose; the
   *  store-side reader resolves that (see `listPendingGatedCalls`). */
  toolName: string;
  toolArgs: unknown;
  createdAt: string | Date;
};

/**
 * TOP-LEVEL argument keys treated as free text — the message, not the target.
 *
 * Adding a key here makes two proposals that differ ONLY in that key
 * indistinguishable, i.e. the second one gets refused. Removing one makes a
 * reworded proposal get through. Both are policy decisions; a test pins the
 * exact set so neither happens by accident.
 */
export const VOLATILE_ARG_KEYS: ReadonlySet<string> = new Set([
  'body',
  'content',
  'description',
  'html',
  'message',
  'notes',
  'prompt',
  'reason',
  'subject',
  'summary',
  'text',
]);

/** Deep, order-independent canonicalisation. Mirrors loop.ts's `sortKeysDeep`. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function hash(toolName: string, args: unknown): string {
  // The tool name is inside the hashed payload, not concatenated onto it, so a
  // tool named `a` with args `{b:1}` can never collide with a tool named `ab`.
  return createHash('sha256')
    .update(JSON.stringify({ tool: toolName, args: sortKeysDeep(args ?? {}) }))
    .digest('hex');
}

/** Fingerprint of the whole call. Two calls sharing it are byte-equivalent. */
export function exactActionFingerprint(toolName: string, args: unknown): string {
  return hash(toolName, args ?? {});
}

/**
 * Fingerprint of the call's TARGET: the same hash with top-level free-text
 * keys removed. Equal to `exactActionFingerprint` when the call carries none.
 */
export function targetActionFingerprint(toolName: string, args: unknown): string {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return hash(toolName, args ?? {});
  }
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (VOLATILE_ARG_KEYS.has(k)) continue;
    stripped[k] = v;
  }
  return hash(toolName, stripped);
}

export type DuplicateMatch = { approvalId: string; match: 'exact' | 'target' };

/**
 * The OLDEST pending decision equivalent to the call being attempted, or null.
 *
 * Oldest, not newest: the owner's queue is answered front to back, and naming
 * the row they will reach first is the one that helps them. It is also stable
 * under repeated wakes, so the refusal message does not churn.
 */
export function findDuplicatePendingCall(
  pending: readonly PendingGatedCall[],
  toolName: string,
  args: unknown,
): DuplicateMatch | null {
  const exact = exactActionFingerprint(toolName, args);
  const target = targetActionFingerprint(toolName, args);

  let targetHit: DuplicateMatch | null = null;
  for (const p of pending) {
    if (exactActionFingerprint(p.toolName, p.toolArgs) === exact) {
      // An exact match is the strongest answer available; report it
      // immediately rather than letting an earlier target-only match stand in.
      return { approvalId: p.approvalId, match: 'exact' };
    }
    if (!targetHit && targetActionFingerprint(p.toolName, p.toolArgs) === target) {
      targetHit = { approvalId: p.approvalId, match: 'target' };
    }
  }
  return targetHit;
}

/** Coarse "how long has this been sitting" for prompt text. Never precise. */
export function humanizeWait(createdAt: string | Date, now: Date): string {
  const started = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const ms = now.getTime() - started.getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const DESCRIPTION_MAX = 200;

/**
 * ONE LINE per pending decision, for the always-present turn context.
 *
 * Terse on purpose: this block is on every prompt while anything is pending,
 * and the operator wakes on a one-minute tick. Detail on demand is
 * `list_pending_decisions`'s job, which is exactly why that tool exists.
 *
 * Newlines are stripped rather than escaped — a free-text body would otherwise
 * be able to forge extra bullet lines inside a platform-authored block. That is
 * cosmetic, not a control (see the RULE in operator-turn.ts: nothing in the
 * wake message is ever an input to a security decision), but a block that can
 * be visually spoofed by its own contents is not worth shipping.
 */
export function describePendingCall(call: PendingGatedCall, now: Date): string {
  const args = call.toolArgs && typeof call.toolArgs === 'object' ? (call.toolArgs as Record<string, unknown>) : {};
  const digest = Object.entries(args)
    .filter(([k]) => !VOLATILE_ARG_KEYS.has(k))
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  const line = `${call.approvalId} — ${call.toolName}${digest ? ` (${digest})` : ''} — waiting ${humanizeWait(call.createdAt, now)}`;
  const flat = line.replace(/[\r\n]+/g, ' ');
  return flat.length <= DESCRIPTION_MAX ? flat : `${flat.slice(0, DESCRIPTION_MAX - 1)}…`;
}
