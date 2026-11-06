import { describe, expect, it } from 'vitest';
import { QWEN_DEFAULT_MODEL, resolvePlatformDefaultModel } from './model-default';

describe('platform default model', () => {
  it('falls back to Qwen when the environment does not set one', () => {
    expect(resolvePlatformDefaultModel({})).toBe(QWEN_DEFAULT_MODEL);
  });

  it('honours an explicit platform override', () => {
    expect(resolvePlatformDefaultModel({ PLATFORM_DEFAULT_MODEL: 'other/model' }))
      .toBe('other/model');
  });
});
