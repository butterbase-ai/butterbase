import { describe, it, expect } from 'vitest';
import { translateCcStreamToResponsesSse } from './responses-sse.js';

function streamOf(s: string) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
}

function errorStream(err: Error) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.error(err);
    },
  });
}

async function collect(s: ReadableStream<Uint8Array>) {
  const r = s.getReader();
  const dec = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await r.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

function extractEventNames(raw: string): string[] {
  return [...raw.matchAll(/^event: (.+)$/gm)].map((m) => m[1].trim());
}

const CC_PAYLOAD = [
  'data: {"id":"1","choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
  'data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\n',
  'data: {"id":"1","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
  'data: [DONE]\n\n',
].join('');

describe('translateCcStreamToResponsesSse', () => {
  it('emits response.created/output_text.delta/completed', async () => {
    let captured: any;
    const out = await collect(
      translateCcStreamToResponsesSse({
        id: 'rsp_z',
        model: 'm',
        createdAt: 0,
        ccStream: streamOf(CC_PAYLOAD),
        onClose: async (b) => {
          captured = b;
        },
      }),
    );
    expect(out).toContain('event: response.created');
    expect(out).toMatch(/event: response.output_text.delta[\s\S]+"delta":"hi"/);
    expect(out).toContain('event: response.completed');
    expect(captured.output[0].content[0].text).toBe('hi');
  });

  it('emits events in the exact required order', async () => {
    const out = await collect(
      translateCcStreamToResponsesSse({
        id: 'rsp_z',
        model: 'm',
        createdAt: 0,
        ccStream: streamOf(CC_PAYLOAD),
        onClose: async () => {},
      }),
    );
    const events = extractEventNames(out);
    expect(events).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  it('propagates upstream stream errors to the consumer', async () => {
    const boom = new Error('upstream boom');
    const sse = translateCcStreamToResponsesSse({
      id: 'rsp_err',
      model: 'm',
      createdAt: 0,
      ccStream: errorStream(boom),
      onClose: async () => {},
    });
    const reader = sse.getReader();
    // consume the first chunk (response.created), then expect the error
    await reader.read(); // response.created chunk
    await expect(collect(new ReadableStream({ start(c) { c.error(boom); } }))).rejects.toThrow('upstream boom');
    // More directly: draining the whole stream should reject
    const sse2 = translateCcStreamToResponsesSse({
      id: 'rsp_err2',
      model: 'm',
      createdAt: 0,
      ccStream: errorStream(boom),
      onClose: async () => {},
    });
    await expect(collect(sse2)).rejects.toThrow('upstream boom');
  });

  it('threads previousResponseId into response.completed and onClose', async () => {
    let captured: any;
    const out = await collect(
      translateCcStreamToResponsesSse({
        id: 'rsp_child',
        model: 'm',
        createdAt: 0,
        previousResponseId: 'rsp_prev',
        ccStream: streamOf(CC_PAYLOAD),
        onClose: async (b) => {
          captured = b;
        },
      }),
    );

    // Find the response.completed event data
    const completedMatch = out.match(/event: response\.completed\ndata: (.+)/);
    expect(completedMatch).not.toBeNull();
    const completedBody = JSON.parse(completedMatch![1]);
    expect(completedBody.response.previous_response_id).toBe('rsp_prev');

    // onClose receives the same final body
    expect(captured.previous_response_id).toBe('rsp_prev');
  });

  // --- Codex/Responses-API conformance (spike 2026-08-24) ---
  //
  // Two defects, both proven against the live gateway with real Codex CLI:
  //   1. `type` was only on the SSE `event:` line, never inside the JSON data.
  //      Clients (Codex among them) dispatch on the data field and so saw
  //      nothing, then timed out with "stream closed before response.completed".
  //   2. `delta.tool_calls` was not read at all, so every streamed tool call was
  //      silently dropped -- from the wire AND from the persisted final body
  //      that `previous_response_id` continuation replays.

  const CC_TOOL_PAYLOAD = [
    'data: {"id":"1","choices":[{"delta":{"role":"assistant"}}]}\n\n',
    // arguments deliberately split across chunks -- that is why an accumulator exists
    'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"shell","arguments":"{\\"command\\":"}}]}}]}\n\n',
    'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"[\\"ls\\"]}"}}]}}]}\n\n',
    'data: {"id":"1","choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ].join('');

  it('includes the event type inside the data payload, not only on the event line', async () => {
    const out = await collect(
      translateCcStreamToResponsesSse({
        id: 'rsp_t',
        model: 'm',
        createdAt: 0,
        ccStream: streamOf(CC_PAYLOAD),
        onClose: async () => {},
      }),
    );
    const created = JSON.parse(out.match(/event: response\.created\ndata: (.+)/)![1]);
    expect(created.type).toBe('response.created');
    const completed = JSON.parse(out.match(/event: response\.completed\ndata: (.+)/)![1]);
    expect(completed.type).toBe('response.completed');
  });

  it('emits a function_call item for a tool call streamed across chunks', async () => {
    const out = await collect(
      translateCcStreamToResponsesSse({
        id: 'rsp_tool',
        model: 'm',
        createdAt: 0,
        ccStream: streamOf(CC_TOOL_PAYLOAD),
        onClose: async () => {},
      }),
    );
    expect(extractEventNames(out)).toContain('response.function_call_arguments.done');
    const doneEvt = out.match(/event: response\.function_call_arguments\.done\ndata: (.+)/);
    expect(doneEvt).not.toBeNull();
    // the two argument fragments must be concatenated, in order
    expect(JSON.parse(doneEvt![1]).arguments).toBe('{"command":["ls"]}');
  });

  it('carries streamed tool calls into the final body persisted by onClose', async () => {
    let captured: any;
    await collect(
      translateCcStreamToResponsesSse({
        id: 'rsp_tool2',
        model: 'm',
        createdAt: 0,
        ccStream: streamOf(CC_TOOL_PAYLOAD),
        onClose: async (b) => {
          captured = b;
        },
      }),
    );
    const call = captured.output.find((o: any) => o.type === 'function_call');
    expect(call).toBeDefined();
    expect(call.call_id).toBe('call_abc');
    expect(call.name).toBe('shell');
    expect(call.arguments).toBe('{"command":["ls"]}');
  });

});
