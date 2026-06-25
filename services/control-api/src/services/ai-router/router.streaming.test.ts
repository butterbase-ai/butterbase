/**
 * Tests for streaming usage extraction in wrapStreamForSettlement.
 * Covers cache-token propagation for both OpenRouter and ImaRouter SSE shapes.
 */
import { describe, it, expect, vi } from 'vitest';
import { wrapStreamForSettlement } from './router.js';

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) { /* drain */ }
}

// ---------------------------------------------------------------------------
// OpenRouter shape — cache tokens in prompt_tokens_details
// ---------------------------------------------------------------------------

describe('wrapStreamForSettlement — OpenRouter cache tokens', () => {
  it('extracts cacheReadInputTokens from prompt_tokens_details.cached_tokens', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":500,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":500}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = makeStream(chunks);
    let captured: Parameters<Parameters<typeof wrapStreamForSettlement>[1]>[0] | null = null;
    const wrapped = wrapStreamForSettlement(upstream, async (usage) => {
      captured = usage;
    });
    await drainStream(wrapped);
    expect(captured).toMatchObject({ cacheReadInputTokens: 500 });
  });

  it('extracts cacheCreationInputTokens from prompt_tokens_details.cache_write_tokens', async () => {
    const chunks = [
      'data: {"usage":{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":1000}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = makeStream(chunks);
    let captured: Parameters<Parameters<typeof wrapStreamForSettlement>[1]>[0] | null = null;
    const wrapped = wrapStreamForSettlement(upstream, async (usage) => {
      captured = usage;
    });
    await drainStream(wrapped);
    expect(captured).toMatchObject({ cacheCreationInputTokens: 1000 });
  });

  it('leaves cache fields at 0 when prompt_tokens_details is absent', async () => {
    const chunks = [
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = makeStream(chunks);
    let captured: Parameters<Parameters<typeof wrapStreamForSettlement>[1]>[0] | null = null;
    const wrapped = wrapStreamForSettlement(upstream, async (usage) => {
      captured = usage;
    });
    await drainStream(wrapped);
    expect(captured).toMatchObject({ cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  });

  it('captures both cache fields together', async () => {
    const chunks = [
      'data: {"usage":{"prompt_tokens":1500,"completion_tokens":300,"prompt_tokens_details":{"cached_tokens":500,"cache_write_tokens":1000}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = makeStream(chunks);
    let captured: Parameters<Parameters<typeof wrapStreamForSettlement>[1]>[0] | null = null;
    const wrapped = wrapStreamForSettlement(upstream, async (usage) => {
      captured = usage;
    });
    await drainStream(wrapped);
    expect(captured).toMatchObject({ cacheReadInputTokens: 500, cacheCreationInputTokens: 1000 });
  });
});

// ---------------------------------------------------------------------------
// ImaRouter shape — claude_cache_creation_*_tokens, prompt_tokens normalization
// ---------------------------------------------------------------------------

describe('wrapStreamForSettlement — ImaRouter cache tokens', () => {
  it('sums claude_cache_creation_5_m_tokens + claude_cache_creation_1_h_tokens into cacheCreationInputTokens', async () => {
    const chunks = [
      'data: {"usage":{"prompt_tokens":800,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":200},"claude_cache_creation_5_m_tokens":4000,"claude_cache_creation_1_h_tokens":2003}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = makeStream(chunks);
    let captured: Parameters<Parameters<typeof wrapStreamForSettlement>[1]>[0] | null = null;
    const wrapped = wrapStreamForSettlement(upstream, async (usage) => {
      captured = usage;
    });
    await drainStream(wrapped);
    expect(captured).toMatchObject({
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 6003, // 4000 + 2003
    });
  });

  it('normalizes promptTokens when ImaRouter excludes cached tokens (adds cacheRead back)', async () => {
    // ImaRouter sends prompt_tokens=800 but it excludes the 200 cached tokens.
    // The parser should produce promptTokens = 800 + 200 = 1000.
    const chunks = [
      'data: {"usage":{"prompt_tokens":800,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":200},"claude_cache_creation_5_m_tokens":4000,"claude_cache_creation_1_h_tokens":0}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = makeStream(chunks);
    let captured: Parameters<Parameters<typeof wrapStreamForSettlement>[1]>[0] | null = null;
    const wrapped = wrapStreamForSettlement(upstream, async (usage) => {
      captured = usage;
    });
    await drainStream(wrapped);
    expect(captured).toMatchObject({
      promptTokens: 1000,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 4000,
    });
  });

  it('does NOT add cacheRead to promptTokens when ImaRouter fields are absent (standard OpenRouter shape)', async () => {
    // Standard OpenRouter: prompt_tokens already includes cached tokens.
    // No claude_cache_creation_* present → no normalization.
    const chunks = [
      'data: {"usage":{"prompt_tokens":500,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":500}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = makeStream(chunks);
    let captured: Parameters<Parameters<typeof wrapStreamForSettlement>[1]>[0] | null = null;
    const wrapped = wrapStreamForSettlement(upstream, async (usage) => {
      captured = usage;
    });
    await drainStream(wrapped);
    // prompt_tokens should stay at 500 (not 500+500=1000)
    expect(captured).toMatchObject({ promptTokens: 500, cacheReadInputTokens: 500 });
  });

  it('handles zero-valued ImaRouter creation tokens without normalizing promptTokens', async () => {
    const chunks = [
      'data: {"usage":{"prompt_tokens":300,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":100},"claude_cache_creation_5_m_tokens":0,"claude_cache_creation_1_h_tokens":0}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = makeStream(chunks);
    let captured: Parameters<Parameters<typeof wrapStreamForSettlement>[1]>[0] | null = null;
    const wrapped = wrapStreamForSettlement(upstream, async (usage) => {
      captured = usage;
    });
    await drainStream(wrapped);
    // Both creation fields are 0 → not an ImaRouter cache-write response;
    // presence of the keys alone indicates ImaRouter shape (prompt_tokens excludes cached).
    // promptTokens should be normalized: 300 + 100 = 400.
    expect(captured).toMatchObject({
      promptTokens: 400,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 0,
    });
  });

  it('does NOT double-add cacheRead when a second usage event arrives without prompt_tokens', async () => {
    // First event: ImaRouter shape with prompt_tokens=800, cached_tokens=6003 → normalized to 6803.
    // Second event: usage present but prompt_tokens absent → must NOT re-add cacheRead.
    // Expected final promptTokens = 6803 (not 6803 + 6003).
    const chunks = [
      'data: {"usage":{"prompt_tokens":800,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":6003},"claude_cache_creation_5_m_tokens":4000,"claude_cache_creation_1_h_tokens":2003}}\n\n',
      'data: {"usage":{"completion_tokens":150}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = makeStream(chunks);
    let captured: Parameters<Parameters<typeof wrapStreamForSettlement>[1]>[0] | null = null;
    const wrapped = wrapStreamForSettlement(upstream, async (usage) => {
      captured = usage;
    });
    await drainStream(wrapped);
    // promptTokens should be 800 + 6003 = 6803 (no double-add)
    expect(captured).toMatchObject({
      promptTokens: 6803,
      completionTokens: 150,
    });
  });
});

// ---------------------------------------------------------------------------
// Split-line robustness — SSE data: line bisected across TCP chunks
// ---------------------------------------------------------------------------

describe('wrapStreamForSettlement — split-line SSE robustness', () => {
  it('extracts cacheReadInputTokens correctly when data: line is split across two TCP chunks', async () => {
    // Build a full SSE usage line and split it mid-JSON to simulate a TCP boundary.
    const fullLine = 'data: {"usage":{"prompt_tokens":800,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":6003},"claude_cache_creation_5_m_tokens":4000,"claude_cache_creation_1_h_tokens":2003}}\n\n';
    const splitAt = Math.floor(fullLine.length / 2);
    const chunks = [
      fullLine.slice(0, splitAt),
      fullLine.slice(splitAt),
      'data: [DONE]\n\n',
    ];
    const upstream = makeStream(chunks);
    let captured: Parameters<Parameters<typeof wrapStreamForSettlement>[1]>[0] | null = null;
    const wrapped = wrapStreamForSettlement(upstream, async (usage) => {
      captured = usage;
    });
    await drainStream(wrapped);
    expect(captured).toMatchObject({
      cacheReadInputTokens: 6003,
      promptTokens: 6803, // 800 + 6003
    });
  });
});

describe('wrapStreamForSettlement — costFetcher hook', () => {
  it('calls costFetcher after [DONE] when no in-stream providerCost was seen', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = new ReadableStream<Uint8Array>({
      start(c) { for (const c2 of chunks) c.enqueue(new TextEncoder().encode(c2)); c.close(); },
    });
    let captured: number | null = -1;
    const costFetcher = vi.fn().mockResolvedValue(0.000077);
    const wrapped = wrapStreamForSettlement(upstream, async (_usage, providerCost) => { captured = providerCost; }, costFetcher);

    const reader = wrapped.getReader();
    while (true) { const { done } = await reader.read(); if (done) break; }

    expect(costFetcher).toHaveBeenCalledTimes(1);
    expect(captured).toBe(0.000077);
  });

  it('skips costFetcher when an in-stream providerCost was already observed', async () => {
    const chunks = [
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":1,"cost":0.0001}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = new ReadableStream<Uint8Array>({
      start(c) { for (const c2 of chunks) c.enqueue(new TextEncoder().encode(c2)); c.close(); },
    });
    let captured: number | null = -1;
    const costFetcher = vi.fn().mockResolvedValue(0.9);
    const wrapped = wrapStreamForSettlement(upstream, async (_usage, providerCost) => { captured = providerCost; }, costFetcher);

    const reader = wrapped.getReader();
    while (true) { const { done } = await reader.read(); if (done) break; }

    expect(costFetcher).not.toHaveBeenCalled();
    expect(captured).toBe(0.0001);
  });
});
