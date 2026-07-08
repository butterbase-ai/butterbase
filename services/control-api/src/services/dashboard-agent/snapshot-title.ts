/**
 * Snapshot auto-naming (Plan 3d Task 5).
 *
 * Every time an app's working tree is flushed to a new manage_repo snapshot,
 * the loop derives a short human-readable title for it:
 *   - Short user messages (<120 chars) are used verbatim — cheapest, most
 *     accurate label for the common "small edit" turn.
 *   - Longer turns get a cheap LLM summary (4-8 words) via the AI gateway.
 *     This call is best-effort: a 5s timeout and any failure fall back to
 *     `Turn <N>` so labeling never blocks or fails the SSE stream.
 */

const SHORT_MESSAGE_THRESHOLD = 120;
const GATEWAY_TIMEOUT_MS = 5000;

export type SnapshotTitleGateway = {
  chat: (input: { prompt: string; timeoutMs: number }) => Promise<string>;
};

/**
 * Default gateway implementation: a single non-streaming chat completion
 * against the AI gateway, using the same AI_GATEWAY_URL env var and bearer
 * JWT pattern as the main loop's streamChatCompletion.
 */
export function createGatewayChat(jwt: string): SnapshotTitleGateway {
  return {
    async chat({ prompt, timeoutMs }) {
      const url = `${process.env.AI_GATEWAY_URL ?? 'http://localhost:3000'}/v1/chat/completions`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({
            model: 'anthropic/claude-haiku-4.5',
            messages: [{ role: 'user', content: prompt }],
            stream: false,
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`gateway ${res.status}`);
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
        };
        const text = data.choices?.[0]?.message?.content ?? '';
        return text.trim();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Compute a short (4-8 word) title for a just-flushed snapshot.
 *
 * - user message < 120 chars → verbatim (trimmed)
 * - otherwise → cheap LLM summary of the exchange, 5s timeout
 * - on any gateway error/timeout → `Turn <N>` fallback
 */
export async function deriveSnapshotTitle(
  userMessage: string,
  assistantText: string,
  gateway: SnapshotTitleGateway,
  turnNumber: number,
): Promise<string> {
  const trimmed = userMessage.trim();
  if (trimmed.length < SHORT_MESSAGE_THRESHOLD) {
    return trimmed;
  }

  try {
    const prompt = `Summarize this exchange in 4-8 words as a title. No quotes.\n\nUser: ${userMessage}\n\nAssistant: ${assistantText}`;
    const title = await gateway.chat({ prompt, timeoutMs: GATEWAY_TIMEOUT_MS });
    if (title) return title;
    return `Turn ${turnNumber}`;
  } catch {
    return `Turn ${turnNumber}`;
  }
}
