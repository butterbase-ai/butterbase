import { describe, expect, it, vi } from 'vitest';
import { OfficeClient, OfficeClientError } from '../index.js';
const id = 'b9bb028e-e99c-4c9b-aa74-d4d96b462391';
const org = 'de471e72-82e4-41ce-bac4-20bd6755b108';
const started = { sequence: 1, type: 'started', turn_id: id, conversation_id: id };
const delta = { sequence: 2, type: 'text_delta', text: 'Example 🌿\nnext' };
const completed = { sequence: 3, type: 'completed', turn_id: id, conversation_id: id };
const frame = (value: { sequence: number; type: string }, crlf = false) => `id: ${value.sequence}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`.replaceAll('\n', crlf ? '\r\n' : '\n');
function response(text: string, fail = false) {
  const bytes = new TextEncoder().encode(text); let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset));
    else if (fail) controller.error(new Error('raw socket diagnostic')); else controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
function clientFor(fetch: typeof globalThis.fetch) { return new OfficeClient({ apiUrl: 'https://api.example', organizationId: org, getToken: () => 'platform-key', fetch }); }
async function collect(events: AsyncIterable<unknown>) { const result = []; for await (const event of events) result.push(event); return result; }
describe('Office public event observation', () => {
  it('decodes UTF-8 byte splits, fragmented CRLF and multiline data, submitting exactly once', async () => {
    const multiline = 'id: 2\r\nevent:text_delta\r\ndata: {"sequence":2,\r\ndata: "type":"text_delta","text":"Example 🌿\\nnext"}\r\n\r\n';
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ state: 'running', turn_id: id, conversation_id: id, output: '' })))
      .mockResolvedValueOnce(response(frame(started, true) + multiline + frame(completed, true), true));
    expect(await collect(clientFor(fetch).askStream('Question'))).toEqual([started, delta, completed]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(1);
  });
  it('switches observation modes using exact IDs without sending another question and skips replay duplicates', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(frame(delta) + frame(delta) + frame(completed)));
    const result = await collect(clientFor(fetch).askStream('', { conversationId: id, turnId: id, afterSequence: 1 }));
    expect(result).toEqual([delta, completed]); expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain(`/conversations/${id}/turns/${id}/events?after_sequence=1`);
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');
  });
  it.each(['', frame(started), frame(started) + frame(delta)])('throws a typed disconnect before terminal, with exact replay pointers', async text => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(text));
    await expect(collect(clientFor(fetch).askStream('', { conversationId: id, turnId: id }))).rejects.toMatchObject({
      code: 'connection_error', conversationId: id, turnId: id, lastSequence: text.includes('text_delta') ? 2 : text ? 1 : 0,
    });
  });
  it('finishes on a durable approval suspension without restarting or waiting for model continuation', async () => {
    const approval = { sequence: 2, type: 'approval_required', decision: { source: 'office', id } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(frame(started) + frame(approval)));
    expect(await collect(clientFor(fetch).askStream('', { conversationId: id, turnId: id }))).toEqual([started, approval]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves HTTP410 history pointers rather than treating expired replay as completion', async () => {
    const history = { turn_id: id, conversation_id: id, state: 'completed' };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'events_expired', message: 'Fetch final history.', history } }), { status: 410 }));
    await expect(collect(clientFor(fetch).askStream('', { conversationId: id, turnId: id }))).rejects.toMatchObject({ code: 'events_expired', history });
  });
  it('replays a resolved suspension through the existing decision_resolved event without hiding its outcome', async () => {
    const approval = { sequence: 2, type: 'approval_required', decision: { source: 'office', id } };
    const resolution = { sequence: 3, type: 'decision_resolved', decision: { source: 'office', id }, resolution: 'approved' };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(frame(started) + frame(approval) + frame(resolution)));
    expect(await collect(clientFor(fetch).askStream('', { conversationId: id, turnId: id }))).toEqual([started, approval, resolution]);
    const replay = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(frame(resolution)));
    expect(await collect(clientFor(replay).askStream('', { conversationId: id, turnId: id, afterSequence: 2 }))).toEqual([resolution]);
  });
  it.each([
    'data: {bad}\n\n',
    frame({ sequence: 1, type: 'internal_secret', token: 'private' } as never),
    frame(started) + frame({ ...completed, sequence: 4 }),
    frame({ ...started, conversation_id: 'another-conversation' } as never),
  ])('rejects malformed, private, gapped or mismatched public frames', async text => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(text));
    await expect(collect(clientFor(fetch).askStream('', { conversationId: id, turnId: id }))).rejects.toBeInstanceOf(OfficeClientError);
    await expect(collect(clientFor(vi.fn().mockResolvedValue(response(text))).askStream('', { conversationId: id, turnId: id }))).rejects.toMatchObject({ code: 'protocol_error' });
  });
  it('aborts only observation, cancelling the reader without another POST', async () => {
    const abort = new AbortController(); let cancelled = false;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const observing = collect(clientFor(fetch).askStream('', { conversationId: id, turnId: id, signal: abort.signal }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); abort.abort();
    await expect(observing).rejects.toMatchObject({ code: 'aborted' }); expect(cancelled).toBe(true);
    expect(fetch.mock.calls.every(c => c[1]?.method === 'GET')).toBe(true);
  });
  it('bounds individual frames while accepting many valid frames in one network chunk', async () => {
    const deltas = Array.from({ length: 24 }, (_, index) => ({ sequence: index + 2, type: 'text_delta', text: 'x'.repeat(10000) }));
    const text = frame(started) + deltas.map(value => frame(value)).join('') + frame({ ...completed, sequence: 26 });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(text)); controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    expect(await collect(clientFor(fetch).askStream('', { conversationId: id, turnId: id }))).toHaveLength(26);
  });
});
