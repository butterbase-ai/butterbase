import type pg from 'pg';
import type { Message } from './store.js';
import { invalidCutPoints, replayCost, trimOperatorHistory } from './operator-history.js';
import {
  getContextSummary,
  upsertContextSummary,
  type ContextSummary,
} from './context-summary-store.js';

/**
 * Replay compaction: the levers, in order, are clear -> summarize -> trim.
 *
 * Nothing here deletes or rewrites a stored message. `messages` are copies
 * used to build the next model request; the summary and watermark are stored
 * so the next turn can replay a small prefix plus the recent tail.
 */

export type CompactionGateway = {
  chat: (input: { prompt: string; timeoutMs: number }) => Promise<string>;
};

export type CompactionTrigger =
  | 'under_budget'
  | 'cleared'
  | 'summarized'
  | 'summary_failed'
  | 'summary_missing_table';

export type CompactionResult = {
  messages: Message[];
  summary: string | null;
  compacted: boolean;
  trigger: CompactionTrigger;
  beforeChars: number;
  afterChars: number;
};

export const DEFAULT_CONTEXT_BUDGET_CHARS = 600_000;
export const DEFAULT_COMPACT_TAIL_CHARS = 120_000;
export const DEFAULT_COMPACT_KEEP_MESSAGES = 24;
export const DEFAULT_COMPACT_PROMPT_CHARS = 150_000;
export const DEFAULT_SUMMARY_MAX_CHARS = 12_000;
export const DEFAULT_CLEAR_KEEP_MESSAGES = 24;
export const MIN_CLEARABLE_RESULT_CHARS = 1_000;
export const COMPACTION_TIMEOUT_MS = 20_000;

const MESSAGE_PROMPT_CAP = 4_000;
const SUMMARY_HEADINGS = [
  '1. Primary request and intent',
  '2. Key technical concepts',
  '3. Files and data touched',
  '4. Errors and fixes',
  '5. Decisions made',
  '6. All user messages (verbatim, each trimmed)',
  '7. Pending tasks',
  '8. Current work',
  '9. Next step',
];

function envPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function replayChars(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + replayCost(message), 0);
}

/**
 * Replace old, large tool results with stubs that still name their row.
 *
 * The `role:'tool'` row is preserved, so the call/result pairing is untouched;
 * only `toolResult` changes. `read_tool_result` still reads the raw row. Small
 * results are left alone, and the last `keepLastMessages` rows stay verbatim.
 */
export function clearOldToolResults(
  messages: Message[],
  keepLastMessages = DEFAULT_CLEAR_KEEP_MESSAGES,
): Message[] {
  const cutoff = messages.length - Math.max(0, keepLastMessages);
  let changed = false;

  const out = messages.map((message, index) => {
    if (index >= cutoff || message.role !== 'tool') return message;
    const text = JSON.stringify(message.toolResult ?? {});
    if (text.length < MIN_CLEARABLE_RESULT_CHARS) return message;

    changed = true;
    return {
      ...message,
      toolResult: {
        cleared: true,
        message_id: message.id,
        original_characters: text.length,
        note: 'Old tool result cleared from replay. Call read_tool_result with this message_id to retrieve it.',
      },
    };
  });

  return changed ? out : messages;
}

/**
 * Drop messages already covered by the stored summary.
 *
 * The id is authoritative when the watermark row is still present; a deleted
 * row falls back to creation time. If neither can locate it, replay nothing
 * extra: the watermark is newer than everything stored.
 */
export function messagesAfterWatermark(
  messages: Message[],
  summary: ContextSummary | null,
): Message[] {
  if (!summary) return messages;

  const byId = messages.findIndex((message) => message.id === summary.throughMessageId);
  if (byId !== -1) return messages.slice(byId + 1);

  const byTime = messages.findIndex(
    (message) => message.createdAt.getTime() > summary.throughCreatedAt.getTime(),
  );
  return byTime === -1 ? [] : messages.slice(byTime);
}

function capPromptText(text: string): string {
  return text.length <= MESSAGE_PROMPT_CAP
    ? text
    : `${text.slice(0, MESSAGE_PROMPT_CAP)}…[truncated]`;
}

export function buildCompactionPrompt(
  messages: Message[],
  previousSummary: string | null,
): string {
  const lines: string[] = [
    'You are compacting earlier parts of a long conversation between a user and the Butterbase agent.',
    'Write a compact, factual summary. Do not invent details. Return plain text under these headings:',
    ...SUMMARY_HEADINGS,
    '',
    'Previous summary (may be empty):',
    previousSummary ?? '(none)',
    '',
    'Conversation to summarize:',
  ];

  for (const message of messages) {
    if (message.role === 'tool') {
      lines.push(`TOOL ${message.toolName ?? 'result'}: ${capPromptText(JSON.stringify(message.toolResult ?? {}))}`);
    } else if (message.role === 'assistant') {
      const call = message.toolCallId
        ? ` [tool_call ${message.toolName ?? ''} ${JSON.stringify(message.toolArgs ?? {})}]`
        : '';
      lines.push(`ASSISTANT: ${capPromptText((message.content ?? '') + call)}`);
    } else if (message.role === 'user') {
      lines.push(`USER: ${capPromptText(message.content ?? '')}`);
    } else {
      lines.push(`SYSTEM: ${capPromptText(message.content ?? '')}`);
    }
  }

  return lines.join('\n');
}

/**
 * Move a trim-selected cut earlier until both the prefix and the cut itself
 * are valid for summarization. Decreasing the cut moves messages into the
 * tail, so the replay keeps more recent context at the cost of a larger tail.
 */
function shrinkCutForPrompt(
  messages: Message[],
  initialCut: number,
  promptChars: number,
): number {
  if (initialCut <= 0) return 0;

  const invalid = invalidCutPoints(messages);
  let cut = Math.min(initialCut, messages.length);
  let prefixChars = 0;
  for (let i = 0; i < cut; i++) prefixChars += replayCost(messages[i]);

  while (cut > 0 && (invalid[cut] || prefixChars > promptChars)) {
    cut -= 1;
    prefixChars -= replayCost(messages[cut]);
  }

  return cut;
}

function logCompaction(fields: Record<string, unknown>): void {
  if (process.env.NODE_ENV === 'test') return;
  console.info('[dashboard-agent] context_compaction', JSON.stringify(fields));
}

export async function compactReplay(input: {
  pool: pg.Pool;
  conversationId: string;
  messages: Message[];
  gateway: CompactionGateway;
  budgetChars?: number;
  keepMessages?: number;
  tailChars?: number;
  promptChars?: number;
  force?: boolean;
}): Promise<CompactionResult> {
  const budgetChars = input.budgetChars
    ?? envPositiveInt('DASHBOARD_AGENT_CONTEXT_BUDGET_CHARS', DEFAULT_CONTEXT_BUDGET_CHARS);
  const tailChars = input.tailChars
    ?? envPositiveInt('DASHBOARD_AGENT_COMPACT_TAIL_CHARS', DEFAULT_COMPACT_TAIL_CHARS);
  const keepMessages = input.keepMessages
    ?? envPositiveInt('DASHBOARD_AGENT_COMPACT_KEEP_MESSAGES', DEFAULT_COMPACT_KEEP_MESSAGES);
  const promptChars = input.promptChars ?? DEFAULT_COMPACT_PROMPT_CHARS;
  const beforeChars = replayChars(input.messages);

  if (!input.force && beforeChars <= budgetChars) {
    return {
      messages: input.messages,
      summary: null,
      compacted: false,
      trigger: 'under_budget',
      beforeChars,
      afterChars: beforeChars,
    };
  }

  let existing: ContextSummary | null;
  try {
    existing = await getContextSummary(input.pool, input.conversationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const missing = /dashboard_agent_context_summaries|does not exist/i.test(message);
    const trimmed = trimOperatorHistory(input.messages, { maxChars: tailChars, maxMessages: keepMessages });
    const trigger: CompactionTrigger = missing ? 'summary_missing_table' : 'summary_failed';
    logCompaction({
      conversation_id: input.conversationId, mode: 'start_of_turn', trigger,
      before_chars: beforeChars, after_chars: replayChars(trimmed),
    });
    return {
      messages: trimmed,
      summary: null,
      compacted: false,
      trigger,
      beforeChars,
      afterChars: replayChars(trimmed),
    };
  }

  const afterSummary = messagesAfterWatermark(input.messages, existing);
  const existingSummaryChars = existing?.summary.length ?? 0;
  const withSummaryChars = replayChars(afterSummary) + existingSummaryChars;

  if (!input.force && withSummaryChars <= budgetChars) {
    return {
      messages: afterSummary,
      summary: existing?.summary ?? null,
      compacted: false,
      trigger: 'under_budget',
      beforeChars,
      afterChars: withSummaryChars,
    };
  }

  const cleared = clearOldToolResults(afterSummary);
  const clearedChars = replayChars(cleared) + existingSummaryChars;
  if (!input.force && clearedChars <= budgetChars) {
    logCompaction({
      conversation_id: input.conversationId, mode: 'start_of_turn', trigger: 'cleared',
      before_chars: beforeChars, after_chars: clearedChars,
    });
    return {
      messages: cleared,
      summary: existing?.summary ?? null,
      compacted: true,
      trigger: 'cleared',
      beforeChars,
      afterChars: clearedChars,
    };
  }

  const trimmed = trimOperatorHistory(afterSummary, {
    maxChars: tailChars,
    maxMessages: keepMessages,
  });
  const initialCut = afterSummary.length - trimmed.length;
  const cut = shrinkCutForPrompt(afterSummary, initialCut, promptChars);

  const failed = (trigger: CompactionTrigger): CompactionResult => {
    logCompaction({
      conversation_id: input.conversationId, mode: 'start_of_turn', trigger,
      before_chars: beforeChars, after_chars: replayChars(trimmed) + existingSummaryChars,
    });
    return {
      messages: trimmed,
      summary: existing?.summary ?? null,
      compacted: false,
      trigger,
      beforeChars,
      afterChars: replayChars(trimmed) + existingSummaryChars,
    };
  };

  if (cut <= 0) return failed('summary_failed');

  const prefix = afterSummary.slice(0, cut);
  const tail = afterSummary.slice(cut);

  let raw: string;
  try {
    raw = await input.gateway.chat({
      prompt: buildCompactionPrompt(prefix, existing?.summary ?? null),
      timeoutMs: COMPACTION_TIMEOUT_MS,
    });
  } catch {
    return failed('summary_failed');
  }

  const summary = raw.trim().slice(0, DEFAULT_SUMMARY_MAX_CHARS);
  if (!summary) return failed('summary_failed');

  const last = prefix[prefix.length - 1];
  try {
    await upsertContextSummary(input.pool, {
      conversationId: input.conversationId,
      summary,
      throughMessageId: last.id,
      throughCreatedAt: last.createdAt,
      sourceCharacters: replayChars(prefix),
      summaryCharacters: summary.length,
      modelUsed: null,
    });
  } catch {
    return failed('summary_failed');
  }

  const afterChars = replayChars(tail) + summary.length;
  logCompaction({
    conversation_id: input.conversationId, mode: 'start_of_turn', trigger: 'summarized',
    before_chars: beforeChars, after_chars: afterChars,
    summarized_messages: prefix.length, kept_messages: tail.length, summary_chars: summary.length,
  });

  return {
    messages: tail,
    summary,
    compacted: true,
    trigger: 'summarized',
    beforeChars,
    afterChars,
  };
}
