import { describe, it, expect } from 'vitest';
import { consumeSse } from './sse';

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(s)); c.close(); } });
}

describe('consumeSse', () => {
  it('parses data: lines and emits events on blank-line boundaries', async () => {
    const stream = streamFromString(
      'event: log\ndata: line one\n\n' +
      'event: log\ndata: line two\n\n' +
      'event: done\ndata: ok\n\n',
    );
    const seen: { event: string; data: string }[] = [];
    await consumeSse(stream, (e) => seen.push(e));
    expect(seen).toEqual([
      { event: 'log',  data: 'line one' },
      { event: 'log',  data: 'line two' },
      { event: 'done', data: 'ok' },
    ]);
  });

  it('handles multi-line data: blocks', async () => {
    const stream = streamFromString('event: log\ndata: a\ndata: b\n\n' + 'event: done\ndata: x\n\n');
    const seen: { event: string; data: string }[] = [];
    await consumeSse(stream, (e) => seen.push(e));
    expect(seen[0].data).toBe('a\nb');
  });

  it('defaults event to "message" when no event: line present', async () => {
    const stream = streamFromString('data: hello\n\n');
    const seen: { event: string; data: string }[] = [];
    await consumeSse(stream, (e) => seen.push(e));
    expect(seen[0].event).toBe('message');
  });

  it('handles CRLF line endings', async () => {
    const stream = streamFromString('event: log\r\ndata: x\r\n\r\n');
    const seen: { event: string; data: string }[] = [];
    await consumeSse(stream, (e) => seen.push(e));
    expect(seen[0]).toEqual({ event: 'log', data: 'x' });
  });

  it('emits nothing for a stream with no data: lines', async () => {
    const stream = streamFromString('event: ping\n\n');
    const seen: { event: string; data: string }[] = [];
    await consumeSse(stream, (e) => seen.push(e));
    expect(seen).toEqual([]);
  });
});
