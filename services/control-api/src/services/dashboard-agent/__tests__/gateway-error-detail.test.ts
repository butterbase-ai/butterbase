import { describe, it, expect, afterEach, vi } from 'vitest';
import { streamChatCompletion } from '../loop.js';

/**
 * The 2026-08-06 live test found the operator's default model id was unroutable.
 * The gateway said so precisely — `{"error":{"message":"Model not found: …"}}` —
 * and `streamChatCompletion` threw all of it away, leaving a bare `gateway 404`.
 * Diagnosing that took a hand-driven probe against a running gateway. These
 * tests pin the message-preservation contract so it cannot silently regress.
 *
 * Lives in its own file rather than loop.test.ts, which OOMs (pre-existing).
 */
async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of gen) { /* not reached — these all throw */ }
}

const opts = { model: 'anthropic/claude-sonnet-4.5', messages: [], tools: [], jwt: 'jwt' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('streamChatCompletion — gateway error detail', () => {
  it("carries the gateway's own message, not just the status", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({ error: { message: 'Model not found: claude-sonnet-4-5', code: 'model_not_found' } }),
    } as unknown as Response);

    await expect(drain(streamChatCompletion(opts))).rejects.toThrow(
      /Model not found: claude-sonnet-4-5/,
    );
  });

  it('keeps the `gateway <status>` prefix so existing status matchers still work', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: { message: 'Model not found: x' } }),
    } as unknown as Response);

    await expect(drain(streamChatCompletion(opts))).rejects.toThrow(/^gateway 404/);
  });

  it('falls back to the raw body when it is not JSON', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => 'upstream connect error',
    } as unknown as Response);

    await expect(drain(streamChatCompletion(opts))).rejects.toThrow(
      /gateway 502: upstream connect error/,
    );
  });

  it('still throws the plain status when there is no readable body', async () => {
    // Guards the shape loop.test.ts's own mock uses: a response object with no
    // `text` at all. Reading the body is best-effort and must never convert an
    // HTTP error into a different (e.g. TypeError) failure.
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      body: null,
    } as unknown as Response);

    await expect(drain(streamChatCompletion(opts))).rejects.toThrow('gateway 500');
  });

  it('survives a body read that rejects', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => {
        throw new Error('body already consumed');
      },
    } as unknown as Response);

    await expect(drain(streamChatCompletion(opts))).rejects.toThrow('gateway 503');
  });
});
