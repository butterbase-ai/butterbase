import { describe, expect, it } from 'vitest';
import { toolResultContentForModel } from '../loop.js';

describe('toolResultContentForModel', () => {
  it('passes a small tool result through unchanged', () => {
    const result = { messages: [{ id: 'm1', subject: 'hi' }] };
    expect(toolResultContentForModel(result, 10_000)).toBe(JSON.stringify(result));
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
