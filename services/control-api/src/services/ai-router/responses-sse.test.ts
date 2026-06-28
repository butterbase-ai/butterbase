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
});
