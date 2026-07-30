import { describe, it, expect } from 'vitest';
import { messagesRequestSchema, guardMessagesRoutingShape } from './messages-schema.js';

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

describe('guardMessagesRoutingShape', () => {
  const minimal = { model: 'anthropic/claude-opus-4.8', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] };

  it('accepts a minimal valid body', () => {
    const r = guardMessagesRoutingShape(minimal);
    expect(r.ok).toBe(true);
  });

  it('accepts adaptive thinking (Anthropic-native, not in reference schema)', () => {
    const r = guardMessagesRoutingShape({ ...minimal, thinking: { type: 'adaptive' } });
    expect(r.ok).toBe(true);
  });

  it('accepts disabled thinking', () => {
    const r = guardMessagesRoutingShape({ ...minimal, thinking: { type: 'disabled' } });
    expect(r.ok).toBe(true);
  });

  it('accepts image content blocks', () => {
    const r = guardMessagesRoutingShape({
      ...minimal,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] }],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts document content blocks', () => {
    const r = guardMessagesRoutingShape({
      ...minimal,
      messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'x' } }] }],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts unknown top-level fields (future Anthropic additions)', () => {
    const r = guardMessagesRoutingShape({ ...minimal, some_new_2027_field: { nested: true } });
    expect(r.ok).toBe(true);
  });

  it('rejects non-object body', () => {
    expect(guardMessagesRoutingShape(null).ok).toBe(false);
    expect(guardMessagesRoutingShape('hello').ok).toBe(false);
    expect(guardMessagesRoutingShape([]).ok).toBe(false);
  });

  it('rejects missing model', () => {
    const r = guardMessagesRoutingShape({ ...minimal, model: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/model/);
  });

  it('rejects non-positive max_tokens', () => {
    const r = guardMessagesRoutingShape({ ...minimal, max_tokens: 0 });
    expect(r.ok).toBe(false);
  });

  it('rejects empty messages array', () => {
    const r = guardMessagesRoutingShape({ ...minimal, messages: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects non-boolean stream', () => {
    const r = guardMessagesRoutingShape({ ...minimal, stream: 'true' });
    expect(r.ok).toBe(false);
  });
});
