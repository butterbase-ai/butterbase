import { describe, it, expect } from 'vitest';
import { modelIgnoresSamplingParams, stripUnsupportedSamplingParams } from './model-param-policy.js';

describe('modelIgnoresSamplingParams', () => {
  it.each([
    'google/gemini-3.6-flash',
    'google/gemini-3.7-flash',
    'google/gemini-3.8-flash',
    'google/gemini-3.8-flash-image',
    'google/gemini-3.9-pro',
    'google/gemini-4-argon',
    'google/gemini-4.0-flash',
  ])('returns true for %s', (id) => {
    expect(modelIgnoresSamplingParams(id)).toBe(true);
  });

  it.each([
    'google/gemini-2.5-pro',
    'google/gemini-3.5-flash',
    'anthropic/claude-sonnet-5',
    'openai/gpt-4.1-mini',
    'qwen/qwen3.8-flash',
  ])('returns false for %s', (id) => {
    expect(modelIgnoresSamplingParams(id)).toBe(false);
  });

  it('returns true for gemini-3.5-flash-lite (deprecated alongside 3.6+)', () => {
    expect(modelIgnoresSamplingParams('google/gemini-3.5-flash-lite')).toBe(true);
  });
});

describe('stripUnsupportedSamplingParams', () => {
  it('removes temperature, top_p and top_k for a Gemini 3.6+ model', () => {
    const req = {
      model: 'google/gemini-3.8-flash',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      max_tokens: 32,
    };
    const out = stripUnsupportedSamplingParams(req, 'google/gemini-3.8-flash');
    expect(out).toEqual({
      model: 'google/gemini-3.8-flash',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32,
    });
    expect('temperature' in out).toBe(false);
  });

  it('leaves the request untouched for a model that still accepts them', () => {
    const req = { model: 'google/gemini-3.5-flash', messages: [], temperature: 0.7, top_p: 0.9 };
    expect(stripUnsupportedSamplingParams(req, 'google/gemini-3.5-flash')).toBe(req);
  });

  it('does not mutate the caller request', () => {
    const req = { messages: [], temperature: 0.7 };
    stripUnsupportedSamplingParams(req, 'google/gemini-3.8-flash');
    expect(req.temperature).toBe(0.7);
  });

  it('returns the same object when the model has no sampling params to strip', () => {
    const req = { messages: [] };
    expect(stripUnsupportedSamplingParams(req, 'google/gemini-3.8-flash')).toBe(req);
  });
});
