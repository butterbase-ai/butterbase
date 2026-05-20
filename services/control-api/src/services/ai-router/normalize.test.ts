import { describe, it, expect } from 'vitest';
import { canonicalizeUpstreamId, type RouterName } from './normalize.js';

describe('canonicalizeUpstreamId', () => {
  it('passes OpenRouter ids through unchanged (they are already canonical)', () => {
    expect(canonicalizeUpstreamId('openrouter', 'anthropic/claude-3-5-sonnet'))
      .toBe('anthropic/claude-3-5-sonnet');
    expect(canonicalizeUpstreamId('openrouter', 'openai/gpt-4o'))
      .toBe('openai/gpt-4o');
  });

  it('rewrites AI Provider Primary ids via the vendor-prefix heuristic', () => {
    expect(canonicalizeUpstreamId('provider-primary', 'claude-3-5-sonnet'))
      .toBe('anthropic/claude-3-5-sonnet');
    expect(canonicalizeUpstreamId('provider-primary', 'gpt-4o'))
      .toBe('openai/gpt-4o');
  });

  it('returns null for unmappable upstream ids', () => {
    expect(canonicalizeUpstreamId('provider-primary', 'some-private-model-xyz')).toBeNull();
  });

  it('dottifies version segments for claude prefix (hyphen → dot)', () => {
    // Without this, AI Provider Primary's `claude-opus-4-7` would never merge with
    // OpenRouter's `anthropic/claude-opus-4.7`.
    expect(canonicalizeUpstreamId('provider-primary', 'claude-opus-4-7'))
      .toBe('anthropic/claude-opus-4.7');
    expect(canonicalizeUpstreamId('provider-primary', 'claude-haiku-4-5'))
      .toBe('anthropic/claude-haiku-4.5');
    expect(canonicalizeUpstreamId('provider-primary', 'claude-sonnet-4-6'))
      .toBe('anthropic/claude-sonnet-4.6');
  });

  it('maps kimi-* to moonshotai (matches OpenRouter vendor naming)', () => {
    expect(canonicalizeUpstreamId('provider-primary', 'kimi-k2.6'))
      .toBe('moonshotai/kimi-k2.6');
  });

  it('maps newly-added vendor prefixes', () => {
    expect(canonicalizeUpstreamId('provider-primary', 'gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
    expect(canonicalizeUpstreamId('provider-primary', 'glm-5-turbo')).toBe('z-ai/glm-5-turbo');
    expect(canonicalizeUpstreamId('provider-primary', 'grok-4.3')).toBe('x-ai/grok-4.3');
    expect(canonicalizeUpstreamId('provider-primary', 'MiniMax-M2.5')).toBe('minimax/MiniMax-M2.5');
    expect(canonicalizeUpstreamId('provider-primary', 'qwen3.6-plus')).toBe('qwen/qwen3.6-plus');
    expect(canonicalizeUpstreamId('provider-primary', 'seed-2-0-pro-260328')).toBe('bytedance-seed/seed-2-0-pro-260328');
  });

  it('passes through slash-prefixed vendor ids (lowercases the vendor)', () => {
    // AI Provider Primary publishes PixVerse and similar with explicit vendor prefix.
    expect(canonicalizeUpstreamId('provider-primary', 'PixVerse/v6')).toBe('pixverse/v6');
  });

  it('honors override entries from normalize-overrides.json', () => {
    // claude-sonnet-3.5 is an AI Provider Primary override (period in name; heuristic would map it
    // to claude-* → anthropic prefix giving "anthropic/claude-sonnet-3.5", but the override
    // pins it to the canonical "anthropic/claude-3-5-sonnet")
    expect(canonicalizeUpstreamId('provider-primary', 'claude-sonnet-3.5'))
      .toBe('anthropic/claude-3-5-sonnet');
  });

  it('rejects OpenRouter ids that do not look canonical (defensive)', () => {
    expect(canonicalizeUpstreamId('openrouter', 'not-canonical')).toBeNull();
  });
});

describe('RouterName type', () => {
  it('accepts the three known routers', () => {
    const a: RouterName = 'openrouter';
    const b: RouterName = 'provider-primary';
    const c: RouterName = 'provider-secondary';
    expect([a, b, c]).toHaveLength(3);
  });
});
