import { describe, it, expect } from 'vitest';
import {
  parseReasoningFromBody,
  stripThinkingSuffix,
  toAnthropicThinking,
  toReasoningEffort,
  effortFromBudget,
  budgetFromEffort,
  extractReasoningTokens,
} from './reasoning.js';

describe('parseReasoningFromBody', () => {
  it('returns null when no reasoning fields are present', () => {
    expect(parseReasoningFromBody({ model: 'x', messages: [] })).toBeNull();
  });
  it('parses Anthropic-shaped thinking', () => {
    const r = parseReasoningFromBody({ thinking: { type: 'enabled', budget_tokens: 10000 } });
    expect(r).toEqual({ enabled: true, effort: 'medium', budgetTokens: 10000 });
  });
  it('parses OpenAI Chat reasoning_effort', () => {
    const r = parseReasoningFromBody({ reasoning_effort: 'high' });
    expect(r).toEqual({ enabled: true, effort: 'high', budgetTokens: 24000 });
  });
  it('parses OpenAI Responses reasoning.effort', () => {
    const r = parseReasoningFromBody({ reasoning: { effort: 'low' } });
    expect(r).toEqual({ enabled: true, effort: 'low', budgetTokens: 4000 });
  });
});

describe('stripThinkingSuffix', () => {
  it('strips :thinking from model id', () => {
    expect(stripThinkingSuffix('anthropic/claude-3.7-sonnet:thinking'))
      .toEqual({ model: 'anthropic/claude-3.7-sonnet', usedSuffix: true });
  });
  it('returns unchanged when suffix absent', () => {
    expect(stripThinkingSuffix('openai/gpt-4o'))
      .toEqual({ model: 'openai/gpt-4o', usedSuffix: false });
  });
});

describe('effortFromBudget / budgetFromEffort', () => {
  it('low/medium/high bucket boundaries', () => {
    expect(effortFromBudget(0)).toBe('low');
    expect(effortFromBudget(7999)).toBe('low');
    expect(effortFromBudget(8000)).toBe('medium');
    expect(effortFromBudget(15999)).toBe('medium');
    expect(effortFromBudget(16000)).toBe('high');
  });
  it('budget midpoints', () => {
    expect(budgetFromEffort('low')).toBe(4000);
    expect(budgetFromEffort('medium')).toBe(12000);
    expect(budgetFromEffort('high')).toBe(24000);
  });
});

describe('toAnthropicThinking / toReasoningEffort', () => {
  const r = { enabled: true, effort: 'high', budgetTokens: 24000 } as const;
  it('produces Anthropic shape', () => {
    expect(toAnthropicThinking(r)).toEqual({ type: 'enabled', budget_tokens: 24000 });
  });
  it('produces OpenAI effort', () => {
    expect(toReasoningEffort(r)).toBe('high');
  });
});

describe('extractReasoningTokens', () => {
  it('reads completion_tokens_details.reasoning_tokens', () => {
    expect(extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: 512 } })).toBe(512);
  });
  it('returns 0 when absent', () => {
    expect(extractReasoningTokens({})).toBe(0);
  });
});
