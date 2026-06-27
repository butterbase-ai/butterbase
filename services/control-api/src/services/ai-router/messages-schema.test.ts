import { describe, it, expect } from 'vitest';
import { messagesRequestSchema } from './messages-schema.js';

describe('messagesRequestSchema', () => {
  it('accepts minimal valid request', () => {
    const r = messagesRequestSchema.parse({
      model: 'anthropic/claude-opus-4.8',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.model).toBe('anthropic/claude-opus-4.8');
  });
  it('accepts system prompt + content blocks + tools + thinking', () => {
    const r = messagesRequestSchema.parse({
      model: 'anthropic/claude-opus-4.8',
      max_tokens: 1024,
      system: 'You are helpful.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_time', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '12:00' }] },
      ],
      tools: [{ name: 'get_time', description: 'time', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
      thinking: { type: 'enabled', budget_tokens: 8000 },
      stream: true,
    });
    expect(r.tools).toHaveLength(1);
  });
  it('rejects when max_tokens missing', () => {
    expect(() => messagesRequestSchema.parse({
      model: 'x', messages: [{ role: 'user', content: 'hi' }],
    })).toThrow();
  });
});
