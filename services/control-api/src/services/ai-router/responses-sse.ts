import type { ResponsesResponseBody } from './responses-translate.js';

export function translateCcStreamToResponsesSse(args: {
  id: string;
  model: string;
  createdAt: number;
  previousResponseId?: string | null;
  ccStream: ReadableStream<Uint8Array>;
  onClose: (final: ResponsesResponseBody) => Promise<void>;
}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buffer = '';
  let opened = false;
  let textAcc = '';
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  /**
   * Streamed tool calls, keyed by the upstream `tool_calls[].index`. Chat
   * Completions splits `function.arguments` across chunks, so the fragments are
   * concatenated here and only emitted once the upstream stream ends.
   */
  const toolCalls = new Map<number, { call_id: string; name: string; arguments: string }>();
  let seq = 0;
  /**
   * `type` MUST appear inside the JSON body, not only on the SSE `event:` line.
   * Responses-API clients dispatch on the data field -- a client reading only
   * the event line is the exception, not the rule -- so omitting it makes every
   * event unclassifiable and the stream looks like it ended without completing.
   */
  const evt = (name: string, p: Record<string, unknown>) =>
    enc.encode(
      `event: ${name}\ndata: ${JSON.stringify({ type: name, sequence_number: seq++, ...p })}\n\n`,
    );

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        evt('response.created', {
          response: {
            id: args.id,
            object: 'response',
            created_at: args.createdAt,
            status: 'in_progress',
            model: args.model,
            output: [],
          },
        }),
      );
      const reader = args.ccStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data.trim() === '[DONE]') continue;
            let p: any;
            try {
              p = JSON.parse(data);
            } catch {
              continue;
            }
            const c = p.choices?.[0]?.delta?.content;
            if (c) {
              if (!opened) {
                controller.enqueue(
                  evt('response.output_item.added', {
                    output_index: 0,
                    item: {
                      type: 'message',
                      id: `msg_${args.id.slice(4, 12)}`,
                      role: 'assistant',
                      content: [],
                    },
                  }),
                );
                opened = true;
              }
              controller.enqueue(
                evt('response.output_text.delta', {
                  output_index: 0,
                  content_index: 0,
                  delta: c,
                }),
              );
              textAcc += c;
            }
            for (const tc of (p.choices?.[0]?.delta?.tool_calls ?? []) as Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>) {
              const k = typeof tc.index === 'number' ? tc.index : 0;
              let cur = toolCalls.get(k);
              if (!cur) {
                cur = { call_id: '', name: '', arguments: '' };
                toolCalls.set(k, cur);
              }
              if (tc.id) cur.call_id = tc.id;
              if (tc.function?.name) cur.name = tc.function.name;
              if (tc.function?.arguments) cur.arguments += tc.function.arguments;
            }
            if (p.usage) usage = p.usage;
          }
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      const output: ResponsesResponseBody['output'] = [];
      let outputIndex = 0;
      if (opened) {
        controller.enqueue(
          evt('response.output_text.done', {
            output_index: outputIndex,
            content_index: 0,
            text: textAcc,
          }),
        );
        const messageItem = {
          type: 'message' as const,
          id: `msg_${args.id.slice(4, 12)}`,
          role: 'assistant' as const,
          content: [{ type: 'output_text' as const, text: textAcc }],
        };
        controller.enqueue(
          evt('response.output_item.done', { output_index: outputIndex, item: messageItem }),
        );
        output.push(messageItem);
        outputIndex += 1;
      }
      /**
       * Tool calls are emitted after the upstream stream closes because the
       * arguments are only complete then. They also go into `output` -- the
       * body handed to `onClose` and replayed by `previous_response_id`, so
       * dropping them here loses the call from stored history too.
       */
      for (const call of toolCalls.values()) {
        const item = {
          type: 'function_call' as const,
          id: `fc_${args.id.slice(4, 12)}_${outputIndex}`,
          call_id: call.call_id,
          name: call.name,
          arguments: call.arguments,
        };
        controller.enqueue(evt('response.output_item.added', { output_index: outputIndex, item }));
        controller.enqueue(
          evt('response.function_call_arguments.delta', {
            item_id: item.id,
            output_index: outputIndex,
            delta: call.arguments,
          }),
        );
        controller.enqueue(
          evt('response.function_call_arguments.done', {
            item_id: item.id,
            output_index: outputIndex,
            arguments: call.arguments,
          }),
        );
        controller.enqueue(evt('response.output_item.done', { output_index: outputIndex, item }));
        output.push(item);
        outputIndex += 1;
      }
      const final: ResponsesResponseBody = {
        id: args.id,
        object: 'response',
        created_at: args.createdAt,
        status: 'completed',
        model: args.model,
        previous_response_id: args.previousResponseId ?? null,
        output,
        usage: {
          input_tokens: usage?.prompt_tokens ?? 0,
          output_tokens: usage?.completion_tokens ?? 0,
          total_tokens: (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
        },
      };
      controller.enqueue(evt('response.completed', { response: final }));
      controller.close();
      try {
        await args.onClose(final);
      } catch {
        /* swallow — persistence failure is non-fatal to the stream */
      }
    },
  });
}
