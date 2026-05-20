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
