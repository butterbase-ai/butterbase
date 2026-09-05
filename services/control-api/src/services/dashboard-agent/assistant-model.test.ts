import { describe, it, expect } from 'vitest';
import { DEFAULT_ASSISTANT_MODEL, resolveAssistantModel } from './assistant-model.js';

describe('resolveAssistantModel', () => {
  it('falls back to the default when no id is supplied', () => {
    expect(resolveAssistantModel()).toBe(DEFAULT_ASSISTANT_MODEL);
    expect(resolveAssistantModel(null)).toBe(DEFAULT_ASSISTANT_MODEL);
    expect(resolveAssistantModel(undefined)).toBe(DEFAULT_ASSISTANT_MODEL);
  });

  // The behaviour this whole change exists for: before it, the resolver
  // discarded its argument and always returned the pinned id, so the picker
  // could not take effect.
  it('honours an explicitly requested model', () => {
    expect(resolveAssistantModel('openai/gpt-6-astra')).toBe('openai/gpt-6-astra');
    expect(resolveAssistantModel('anthropic/claude-opus-4.7')).toBe('anthropic/claude-opus-4.7');
  });

  it('treats blank and whitespace-only ids as absent', () => {
    // zod's .default() only fires on a MISSING key, so `{"model": ""}` reaches
    // the resolver as an empty string. Forwarding that verbatim would surface
    // as a model_not_found from the gateway.
    expect(resolveAssistantModel('')).toBe(DEFAULT_ASSISTANT_MODEL);
    expect(resolveAssistantModel('   ')).toBe(DEFAULT_ASSISTANT_MODEL);
    expect(resolveAssistantModel('\t\n')).toBe(DEFAULT_ASSISTANT_MODEL);
  });

  it('trims surrounding whitespace off a real id', () => {
    expect(resolveAssistantModel('  openai/gpt-6-astra  ')).toBe('openai/gpt-6-astra');
  });

  it('keeps qwen3.8-max as the default', () => {
    // Pinned in PREFERRED_ROUTER_BY_MODEL (select.ts) — changing this id
    // without updating that map silently drops the direct-vendor routing.
    expect(DEFAULT_ASSISTANT_MODEL).toBe('qwen/qwen3.8-max');
  });
});
