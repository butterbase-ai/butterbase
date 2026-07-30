import { describe, it, expect } from 'vitest';
import { responsesRequestSchema, guardResponsesRoutingShape } from './responses-schema.js';

describe('responsesRequestSchema', () => {
  it('accepts string input', () => {
    expect(responsesRequestSchema.parse({ model: 'openai/gpt-4o', input: 'hello' }).input).toBe('hello');
  });
  it('accepts array of typed input items', () => {
    const r = responsesRequestSchema.parse({
      model: 'openai/gpt-4o',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'function_call', call_id: 'fc_1', name: 'now', arguments: '{}' },
        { type: 'function_call_output', call_id: 'fc_1', output: '12:00' },
      ],
      previous_response_id: 'rsp_abc',
      tools: [{ type: 'function', name: 'now', parameters: { type: 'object' } }],
      reasoning: { effort: 'medium' },
    });
    expect((r.input as any[])).toHaveLength(3);
  });
  it('rejects unknown tool types as zod-passthrough but flagged elsewhere', () => {
    const r = responsesRequestSchema.parse({
      model: 'openai/gpt-4o', input: 'x',
      tools: [{ type: 'web_search_preview' }],
    });
    expect((r.tools as any[])[0].type).toBe('web_search_preview');
  });
});

describe('guardResponsesRoutingShape', () => {
  it('accepts minimal string input', () => {
    const r = guardResponsesRoutingShape({ model: 'openai/gpt-4o', input: 'hi' });
    expect(r.ok).toBe(true);
  });
  it('accepts array input', () => {
    const r = guardResponsesRoutingShape({ model: 'openai/gpt-4o', input: [{ type: 'message', role: 'user', content: 'hi' }] });
    expect(r.ok).toBe(true);
  });
  it('accepts unknown top-level fields (future OpenAI additions)', () => {
    const r = guardResponsesRoutingShape({ model: 'openai/gpt-4o', input: 'hi', reasoning: { effort: 'minimal', custom_2027: true } });
    expect(r.ok).toBe(true);
  });
  it('rejects missing model', () => {
    expect(guardResponsesRoutingShape({ input: 'hi' }).ok).toBe(false);
  });
  it('rejects missing input', () => {
    expect(guardResponsesRoutingShape({ model: 'x' }).ok).toBe(false);
  });
  it('rejects non-string previous_response_id', () => {
    expect(guardResponsesRoutingShape({ model: 'x', input: 'hi', previous_response_id: 5 }).ok).toBe(false);
  });
});
