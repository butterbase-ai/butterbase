import { describe, it, expect } from 'vitest';
import { translateCcStreamToMessagesSse } from './messages-sse.js';

function streamOf(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); } });
}
async function collect(s: ReadableStream<Uint8Array>): Promise<string> {
  const r = s.getReader(); const dec = new TextDecoder(); let out = '';
  while (true) { const { done, value } = await r.read(); if (done) break; out += dec.decode(value); }
  return out;
}

describe('translateCcStreamToMessagesSse', () => {
  it('translates text deltas to content_block_delta with text_delta', async () => {
    const cc = [
      'data: {"id":"1","choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"id":"1","choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"id":"1","choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"id":"1","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const out = await collect(translateCcStreamToMessagesSse('m', streamOf(cc)));
    expect(out).toContain('event: message_start');
    expect(out).toContain('"type":"content_block_start"');
    expect(out).toMatch(/"type":"text_delta","text":"hello"/);
    expect(out).toMatch(/"type":"text_delta","text":" world"/);
    expect(out).toContain('event: message_stop');
  });
});
