import { afterEach, describe, it, expect, vi } from 'vitest';
import { DEFAULT_ASSISTANT_MODEL, resolveAssistantModel } from './assistant-model.js';

describe('resolveAssistantModel', () => {
  afterEach(() => vi.unstubAllEnvs());
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

  it('defaults to the catalog ID for DeepSeek V4.1 Flash', () => {
    expect(DEFAULT_ASSISTANT_MODEL).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('reads the deployment default at resolution time', () => {
    vi.stubEnv('DASHBOARD_ASSISTANT_MODEL', '  vendor/first-model  ');
    expect(resolveAssistantModel()).toBe('vendor/first-model');
    vi.stubEnv('DASHBOARD_ASSISTANT_MODEL', 'vendor/second-model');
    expect(resolveAssistantModel()).toBe('vendor/second-model');
    vi.stubEnv('DASHBOARD_ASSISTANT_MODEL', '   ');
    expect(resolveAssistantModel()).toBe(DEFAULT_ASSISTANT_MODEL);
  });

  it('prefers an explicit choice, then the saved model, over the deployment default', () => {
    vi.stubEnv('DASHBOARD_ASSISTANT_MODEL', 'vendor/deployment-model');
    expect(resolveAssistantModel('vendor/requested-model', 'vendor/saved-model')).toBe('vendor/requested-model');
    expect(resolveAssistantModel(undefined, '  vendor/saved-model  ')).toBe('vendor/saved-model');
    expect(resolveAssistantModel('   ', 'vendor/saved-model')).toBe('vendor/saved-model');
    expect(resolveAssistantModel(undefined, '   ')).toBe('vendor/deployment-model');
  });
});
