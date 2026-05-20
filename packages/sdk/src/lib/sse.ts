export interface SseEvent { event: string; data: string; }

/**
 * Consume an SSE stream, invoking `onEvent` for each fully-buffered event.
 * Resolves when the underlying stream closes. Supports multi-line `data:` blocks.
 */
export async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (e: SseEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let curEvent = 'message';
  const curData: string[] = [];

  const flush = () => {
    if (curData.length === 0) return;
    onEvent({ event: curEvent, data: curData.join('\n') });
    curEvent = 'message';
    curData.length = 0;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line === '') { flush(); continue; }
        if (line.startsWith('event: ')) curEvent = line.slice(7);
        else if (line.startsWith('data: ')) curData.push(line.slice(6));
      }
    }
    flush();
  } finally {
    reader.releaseLock();
  }
}
