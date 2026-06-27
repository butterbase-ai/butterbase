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

describe('translateCcStreamToResponsesSse', () => {
  it('emits response.created/output_text.delta/completed', async () => {
    const cc = [
      'data: {"id":"1","choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"id":"1","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    let captured: any;
    const out = await collect(
      translateCcStreamToResponsesSse({
        id: 'rsp_z',
        model: 'm',
        createdAt: 0,
        ccStream: streamOf(cc),
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
});
