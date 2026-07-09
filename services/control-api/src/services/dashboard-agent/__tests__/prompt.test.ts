import { describe, expect, it } from 'vitest'
import { getSystemPrompt, TOOL_CHEATSHEET, BACKEND_FN_APPENDIX } from '../prompt'

describe('prompt', () => {
  it('includes TOOL_CHEATSHEET in system prompt', () => {
    const prompt = getSystemPrompt()
    expect(prompt).toContain(TOOL_CHEATSHEET)
    expect(prompt).toContain('manage_schema.apply')
    expect(prompt).toContain('manage_rls')
    expect(prompt).toContain('deploy_function')
  })

  it('includes BACKEND_FN_APPENDIX with backend function guidance', () => {
    const prompt = getSystemPrompt()
    expect(prompt).toContain(BACKEND_FN_APPENDIX)
    expect(prompt).toContain('functions/<name>/')
    expect(prompt).toContain('deploy_function_from_workspace')
  })
})
