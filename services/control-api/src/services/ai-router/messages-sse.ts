/**
 * Translate an OpenAI-style chat-completions SSE stream into the Anthropic
 * Messages event stream. Used by `routeMessages` when the chosen upstream
 * does NOT support Anthropic's native /v1/messages — we route through the
 * chat-completions translation layer and re-emit the chunks here.
 *
 * Native streaming bypasses this entirely (bytes are forwarded as-is).
 *
 * Anthropic event order: message_start → content_block_start (only when
 * first content arrives) → content_block_delta (repeated, text_delta only;
 * chat-completions doesn't produce thinking deltas) → content_block_stop →
 * message_delta (with stop_reason + usage) → message_stop.
 */
import { ulid } from 'ulidx';

export function translateCcStreamToMessagesSse(
  model: string,
  cc: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const messageId = `msg_${ulid().toLowerCase().slice(0, 8)}`;
  let buffer = '';
  let blockOpen = false;
  const blockIndex = 0;
  let finishReason: string | null = null;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;

  function event(name: string, payload: unknown): Uint8Array {
    return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
  }
  const stopMap: Record<string, string> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'stop_sequence',
    function_call: 'tool_use',
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(event('message_start', {
        type: 'message_start',
        message: {
          id: messageId, type: 'message', role: 'assistant', model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
      const reader = cc.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data.trim() === '[DONE]') continue;
          let parsed: any;
          try { parsed = JSON.parse(data); } catch { continue; }
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            if (!blockOpen) {
              controller.enqueue(event('content_block_start', {
                type: 'content_block_start', index: blockIndex,
                content_block: { type: 'text', text: '' },
              }));
              blockOpen = true;
            }
            controller.enqueue(event('content_block_delta', {
              type: 'content_block_delta', index: blockIndex,
              delta: { type: 'text_delta', text: delta.content },
            }));
          }
          const fr = parsed.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
          if (parsed.usage) usage = parsed.usage;
        }
      }
      if (blockOpen) {
        controller.enqueue(event('content_block_stop', {
          type: 'content_block_stop', index: blockIndex,
        }));
      }
      controller.enqueue(event('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: stopMap[finishReason ?? 'stop'] ?? 'end_turn',
          stop_sequence: null,
        },
        usage: {
          input_tokens: usage?.prompt_tokens ?? 0,
          output_tokens: usage?.completion_tokens ?? 0,
        },
      }));
      controller.enqueue(event('message_stop', { type: 'message_stop' }));
      controller.close();
    },
  });
}
