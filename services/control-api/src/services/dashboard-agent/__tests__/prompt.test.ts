import { describe, expect, it } from 'vitest'
import { getSystemPrompt, TOOL_CHEATSHEET } from '../prompt'

describe('prompt', () => {
  it('includes TOOL_CHEATSHEET in system prompt', () => {
    const prompt = getSystemPrompt()
    expect(prompt).toContain(TOOL_CHEATSHEET)
    expect(prompt).toContain('manage_schema.apply')
    expect(prompt).toContain('manage_rls')
    expect(prompt).toContain('deploy_function')
  })
})
