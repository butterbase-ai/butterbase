import { describe, it, expectTypeOf } from 'vitest'
import type { AdapterResult } from './types'

describe('AdapterResult.usage cache fields', () => {
  it('exposes cache_read_input_tokens and cache_creation_input_tokens', () => {
    expectTypeOf<NonNullable<AdapterResult['usage']>>().toHaveProperty('cache_read_input_tokens')
    expectTypeOf<NonNullable<AdapterResult['usage']>>().toHaveProperty('cache_creation_input_tokens')
  })
})
