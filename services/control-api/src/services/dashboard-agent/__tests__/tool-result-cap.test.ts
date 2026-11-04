import { describe, expect, it } from 'vitest';
import { toolResultContentForModel } from '../loop.js';

describe('toolResultContentForModel', () => {
  it('passes a small tool result through unchanged', () => {
    const result = { messages: [{ id: 'm1', subject: 'hi' }] };
    expect(toolResultContentForModel(result, 10_000, 'msg-1')).toBe(JSON.stringify(result));
  });

  it('adds the stored row id and a read_tool_result pointer to a truncated envelope', () => {
    const parsed = JSON.parse(toolResultContentForModel({ body: 'x'.repeat(2_000) }, 100, 'msg-1'));
    expect(parsed.truncated).toBe(true);
    expect(parsed.message_id).toBe('msg-1');
    expect(parsed.note).toContain('read_tool_result');
  });

  it('caps a large tool result and marks it truncated', () => {
    const result = { messages: [{ body: 'x'.repeat(200_000) }] };
    const parsed = JSON.parse(toolResultContentForModel(result, 1_000));
    expect(parsed.truncated).toBe(true);
    expect(parsed.original_characters).toBeGreaterThan(1_000);
    expect(parsed.preview).toHaveLength(1_000);
    expect(parsed.note).toContain('full tool result');
  });
});
