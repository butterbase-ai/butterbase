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
  const evt = (name: string, p: unknown) =>
    enc.encode(`event: ${name}\ndata: ${JSON.stringify(p)}\n\n`);

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
            if (p.usage) usage = p.usage;
          }
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      if (opened) {
        controller.enqueue(
          evt('response.output_text.done', {
            output_index: 0,
            content_index: 0,
            text: textAcc,
          }),
        );
        controller.enqueue(
          evt('response.output_item.done', {
            output_index: 0,
            item: {
              type: 'message',
              id: `msg_${args.id.slice(4, 12)}`,
              role: 'assistant',
              content: [{ type: 'output_text', text: textAcc }],
            },
          }),
        );
      }
      const final: ResponsesResponseBody = {
        id: args.id,
        object: 'response',
        created_at: args.createdAt,
        status: 'completed',
        model: args.model,
        previous_response_id: args.previousResponseId ?? null,
        output: opened
          ? [
              {
                type: 'message',
                id: `msg_${args.id.slice(4, 12)}`,
                role: 'assistant',
                content: [{ type: 'output_text', text: textAcc }],
              },
            ]
          : [],
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
