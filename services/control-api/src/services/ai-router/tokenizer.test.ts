import { describe, it, expect } from 'vitest';
import { estimatePromptTokens, pickEncodingForModel } from './tokenizer.js';

describe('pickEncodingForModel', () => {
  it('uses cl100k_base for non-o-series OpenAI models', () => {
    expect(pickEncodingForModel('openai/gpt-4o')).toBe('cl100k_base');
    expect(pickEncodingForModel('openai/gpt-3.5-turbo')).toBe('cl100k_base');
  });

  it('uses o200k_base for o-series models', () => {
    expect(pickEncodingForModel('openai/o1')).toBe('o200k_base');
    expect(pickEncodingForModel('openai/o3-mini')).toBe('o200k_base');
  });

  it('falls back to cl100k_base for non-OpenAI models', () => {
    expect(pickEncodingForModel('anthropic/claude-3-5-sonnet')).toBe('cl100k_base');
    expect(pickEncodingForModel('deepseek/deepseek-chat')).toBe('cl100k_base');
    expect(pickEncodingForModel('moonshot/kimi-k2')).toBe('cl100k_base');
  });
});

describe('estimatePromptTokens', () => {
  it('counts plain string messages', () => {
    const tokens = estimatePromptTokens([
      { role: 'user', content: 'Hello, world!' },
    ], 'anthropic/claude-3-5-sonnet');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  it('counts multi-message conversations as larger than single', () => {
    const single = estimatePromptTokens([
      { role: 'user', content: 'Hello, world!' },
    ], 'openai/gpt-4o');
    const multi = estimatePromptTokens([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello, world!' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' },
    ], 'openai/gpt-4o');
    expect(multi).toBeGreaterThan(single);
  });

  it('handles content parts (text + image_url)', () => {
    const tokens = estimatePromptTokens([
      { role: 'user', content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
      ]},
    ], 'openai/gpt-4o');
    expect(tokens).toBeGreaterThan(85);
  });

  it('returns 0 for empty messages', () => {
    expect(estimatePromptTokens([], 'openai/gpt-4o')).toBe(0);
  });
});

describe('estimatePromptTokens: bounded work on adversarial input', () => {
  // js-tiktoken is quadratic on repetitive input: 16 KB of one repeated
  // character takes ~20s to encode, and a two-character cycle is just as bad,
  // so a "detect long runs" guard does not help. Unbounded encoding let a
  // single request stall the event loop and take the whole process down —
  // these tests pin the bound, not the accuracy.
  const BUDGET_MS = 1000;

  it('returns promptly for a 1 MB repeated-character message', () => {
    const t0 = Date.now();
    const tokens = estimatePromptTokens(
      [{ role: 'user', content: 'A'.repeat(1024 * 1024) }],
      'anthropic/claude-3-5-sonnet',
    );
    const elapsed = Date.now() - t0;
    expect(tokens).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('returns promptly for a two-character cycle (dodges any run detector)', () => {
    const t0 = Date.now();
    estimatePromptTokens(
      [{ role: 'user', content: 'ab'.repeat(512 * 1024) }],
      'anthropic/claude-3-5-sonnet',
    );
    expect(Date.now() - t0).toBeLessThan(BUDGET_MS);
  });

  it('returns promptly for many oversized blocks in one request', () => {
    const big = 'A'.repeat(64 * 1024);
    const t0 = Date.now();
    estimatePromptTokens(
      Array.from({ length: 50 }, () => ({ role: 'user', content: big })),
      'anthropic/claude-3-5-sonnet',
    );
    expect(Date.now() - t0).toBeLessThan(BUDGET_MS);
  });

  it('still scales with content length rather than collapsing to a constant', () => {
    const short = estimatePromptTokens(
      [{ role: 'user', content: 'word '.repeat(2000) }], 'anthropic/claude-3-5-sonnet');
    const long = estimatePromptTokens(
      [{ role: 'user', content: 'word '.repeat(20000) }], 'anthropic/claude-3-5-sonnet');
    expect(long).toBeGreaterThan(short * 5);
  });

  it('stays reasonably accurate on ordinary prose', () => {
    const prose = 'the quick brown fox jumps over the lazy dog. '.repeat(40);
    const est = estimatePromptTokens([{ role: 'user', content: prose }], 'anthropic/claude-3-5-sonnet');
    // ~10 tokens per 45-char sentence => ~400 tokens; allow a wide band.
    expect(est).toBeGreaterThan(250);
    expect(est).toBeLessThan(700);
  });
});
