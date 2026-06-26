import { describe, it, expect, expectTypeOf } from 'vitest'
import type { AdapterResult, RouterAdapter } from './types'

describe('AdapterResult.usage cache fields', () => {
  it('exposes cache_read_input_tokens and cache_creation_input_tokens', () => {
    expectTypeOf<NonNullable<AdapterResult['usage']>>().toHaveProperty('cache_read_input_tokens')
    expectTypeOf<NonNullable<AdapterResult['usage']>>().toHaveProperty('cache_creation_input_tokens')
  })
})

describe('RouterAdapter.capabilities', () => {
  it('exposes supportsNativeMessages(canonicalId) -> boolean', () => {
    const adapter = {
      name: 'openrouter',
      capabilities: { supportsNativeMessages: (_id: string) => false },
    } as unknown as RouterAdapter;
    expect(adapter.capabilities.supportsNativeMessages('anthropic/claude-opus-4.8')).toBe(false);
  });
})
