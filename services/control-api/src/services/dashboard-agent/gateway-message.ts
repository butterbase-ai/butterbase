import type { Message } from './store.js';

/**
 * The OpenAI-compatible message shape the AI gateway receives, and the
 * conversion from persisted rows.
 *
 * Extracted from loop.ts so context-compaction.ts can rebuild the array
 * mid-turn without a loop.ts <-> context-compaction.ts import cycle.
 */
export interface GatewayMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export const DEFAULT_TOOL_RESULT_MODEL_MAX_CHARS = 64_000;

export function toolResultModelMaxChars(): number {
  const raw = process.env.DASHBOARD_AGENT_TOOL_RESULT_MAX_CHARS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_RESULT_MODEL_MAX_CHARS;
}

/**
 * Bound what a single tool result can put into the model context.
 *
 * The full result stays in `dashboard_agent_messages.tool_result`; only the
 * gateway message is capped. Without this, one search that returns full email
 * bodies with base64 parts can exceed the provider's input limit (Qwen rejects
 * requests over 983,616 characters) and the whole turn dies with a 400.
 *
 * The model sees a valid JSON envelope with a preview and a note; it can run a
 * narrower search or fetch a specific record by id to get the rest. When the
 * row id is known, the envelope includes it so `read_tool_result` can search or
 * page the full stored value without another external call.
 */
export function toolResultContentForModel(
  result: unknown,
  maxChars = toolResultModelMaxChars(),
  messageId?: string,
): string {
  const text = JSON.stringify(result ?? {});
  if (text.length <= maxChars) return text;
  return JSON.stringify({
    truncated: true,
    original_characters: text.length,
    message_id: messageId ?? null,
    preview: text.slice(0, maxChars),
    note: 'The full tool result is stored. Call read_tool_result with this message_id to search or page through it.',
  });
}

/**
 * Convert persisted store messages to the gateway's OpenAI-compatible format.
 */
export function toGatewayMessages(messages: Message[]): GatewayMessage[] {
  return messages.map((msg): GatewayMessage => {
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.toolCallId ?? '',
        content: toolResultContentForModel(msg.toolResult, toolResultModelMaxChars(), msg.id),
      };
    }
    if (msg.role === 'assistant' && msg.toolCallId) {
      return {
        role: 'assistant',
        content: msg.content || null,
        tool_calls: [
          {
            id: msg.toolCallId,
            type: 'function',
            function: {
              name: msg.toolName ?? '',
              arguments: JSON.stringify(msg.toolArgs ?? {}),
            },
          },
        ],
      };
    }
    return { role: msg.role, content: msg.content };
  });
}
