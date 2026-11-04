/**
 * Pure read/search helpers for the `read_tool_result` tool.
 *
 * The tool itself only resolves the row (store.ts, conversation-scoped); all
 * formatting and bounds live here so they can be tested without a database.
 * The full result is the JSON text the gateway would have received before the
 * 64k cap; searching and paging operate on that same serialization.
 */

export const DEFAULT_READ_LIMIT = 8_000;
export const MAX_READ_LIMIT = 20_000;
export const MAX_MATCHES = 25;
export const MATCH_CONTEXT_CHARS = 160;
/**
 * A long query would otherwise make each context window huge. 256 + two
 * 160-char sides = 576; 25 × 576 is still under MAX_READ_LIMIT, so the hard
 * output cap below can only be reached by a bug, not by a model-supplied query.
 */
export const MAX_QUERY_CHARS = 256;

export type ReadToolResultInput = {
  messageId: string;
  query?: string;
  offset?: number;
  limit?: number;
};

export type ReadToolResultSlice = {
  message_id: string;
  total_characters: number;
  offset: number;
  returned_characters: number;
  text: string;
  next_offset: number | null;
};

export type ReadToolResultMatch = {
  index: number;
  context: string;
};

export type ReadToolResultMatches = {
  message_id: string;
  total_characters: number;
  query: string;
  match_count: number;
  truncated: boolean;
  matches: ReadToolResultMatch[];
};

export type ReadToolResultOutput = ReadToolResultSlice | ReadToolResultMatches;

export type ParsedReadToolResultArgs =
  | { ok: true; value: ReadToolResultInput }
  | { ok: false; error: 'invalid_arguments' };

const INVALID: ParsedReadToolResultArgs = { ok: false, error: 'invalid_arguments' };

/**
 * `message_id` is a UUID column. Accepting arbitrary text lets a non-UUID reach
 * Postgres and surface its raw `invalid input syntax for type uuid` error,
 * leaking column typing and adding an undefined error shape. The shape check
 * lives here so the tool's contract stays `invalid_arguments`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate model-supplied arguments. Only supplied fields are returned, so
 * `readToolResultText` owns the defaults.
 */
export function parseReadToolResultArgs(args: unknown): ParsedReadToolResultArgs {
  if (!isRecord(args)) return INVALID;

  const messageId = args.message_id;
  if (typeof messageId !== 'string' || messageId.trim().length === 0) return INVALID;
  if (!UUID_RE.test(messageId.trim())) return INVALID;

  const value: ReadToolResultInput = { messageId: messageId.trim() };

  if (args.query !== undefined) {
    if (typeof args.query !== 'string' || args.query.trim().length === 0) return INVALID;
    if (args.query.length > MAX_QUERY_CHARS) return INVALID;
    value.query = args.query;
  }
  if (args.offset !== undefined) {
    if (typeof args.offset !== 'number' || !Number.isInteger(args.offset) || args.offset < 0) return INVALID;
    value.offset = args.offset;
  }
  if (args.limit !== undefined) {
    if (
      typeof args.limit !== 'number' ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > MAX_READ_LIMIT
    ) {
      return INVALID;
    }
    value.limit = args.limit;
  }

  return { ok: true, value };
}

export function readToolResultText(result: unknown, input: ReadToolResultInput): ReadToolResultOutput {
  const text = JSON.stringify(result ?? {});
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_READ_LIMIT, 1), MAX_READ_LIMIT);

  if (input.query !== undefined) {
    return searchMatches(text, input.messageId, input.query, limit);
  }

  const offset = Math.min(Math.max(input.offset ?? 0, 0), text.length);
  const slice = text.slice(offset, offset + limit);
  return {
    message_id: input.messageId,
    total_characters: text.length,
    offset,
    returned_characters: slice.length,
    text: slice,
    next_offset: offset + slice.length < text.length ? offset + slice.length : null,
  };
}

/**
 * Literal, case-insensitive, non-overlapping match search.
 *
 * `limit` bounds the DISTINCT context characters returned, measured as the
 * union of the context intervals. Overlapping windows (dense matches) do not
 * count twice, which is what keeps the 25-match cap reachable without the
 * character budget cutting it short. A first match is always returned even if
 * its own window exceeds the budget.
 */
function searchMatches(
  text: string,
  messageId: string,
  query: string,
  limit: number,
): ReadToolResultMatches {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const matches: ReadToolResultMatch[] = [];
  let truncated = false;
  let from = 0;
  let coveredUntil = 0;
  let consumed = 0;

  while (matches.length < MAX_MATCHES) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;

    const start = Math.max(0, index - MATCH_CONTEXT_CHARS);
    const end = Math.min(text.length, index + needle.length + MATCH_CONTEXT_CHARS);
    const added = Math.max(0, end - Math.max(start, coveredUntil));

    if (matches.length > 0 && consumed + added > limit) {
      truncated = true;
      break;
    }

    matches.push({ index, context: text.slice(start, end) });
    consumed += added;
    coveredUntil = Math.max(coveredUntil, end);
    from = index + needle.length;
  }

  if (matches.length === MAX_MATCHES) {
    truncated = truncated || haystack.indexOf(needle, from) !== -1;
  }

  // Hard ceiling on the returned text, independent of the union-based `limit`.
  // With MAX_QUERY_CHARS this is unreachable, but the contract is a maximum.
  let returned = matches.reduce((total, match) => total + match.context.length, 0);
  while (matches.length > 0 && returned > MAX_READ_LIMIT) {
    const removed = matches.pop()!;
    returned -= removed.context.length;
    truncated = true;
  }

  return {
    message_id: messageId,
    total_characters: text.length,
    query,
    match_count: matches.length,
    truncated,
    matches,
  };
}
