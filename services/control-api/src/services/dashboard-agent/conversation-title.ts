/**
 * Conversation auto-titling (Plan 3e Task 2).
 *
 * After the first assistant turn of a brand-new conversation (still on the
 * default "New conversation" title), the loop fires a single one-shot LLM
 * call to summarize the exchange into a short (3-6 word) title. Best-effort:
 * a 6s timeout and any error/empty response return `null` so the caller can
 * silently skip the update — the user can always rename later.
 */

import type { SnapshotTitleGateway } from './snapshot-title.js';

const TITLE_TIMEOUT_MS = 6000;

/**
 * Summarize a user/assistant exchange into a 3-6 word conversation title.
 * Returns `null` on any gateway error, timeout, or empty response.
 */
export async function generateConversationTitle(
  userMessage: string,
  assistantContent: string,
  gateway: SnapshotTitleGateway,
): Promise<string | null> {
  try {
    const prompt =
      `Summarize this exchange as a 3-6 word conversation title. No quotes. No trailing period.\n\n` +
      `User: ${userMessage}\n\nAssistant: ${assistantContent}`;
    const title = await gateway.chat({ prompt, timeoutMs: TITLE_TIMEOUT_MS });
    const trimmed = title.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
