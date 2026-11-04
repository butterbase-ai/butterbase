import { describe, expect, it } from 'vitest';
import { parseReadToolResultArgs, readToolResultText } from '../read-tool-result.js';

const result = { body: 'x'.repeat(5000) + 'CALCULATOR' + 'y'.repeat(5000) };

describe('parseReadToolResultArgs', () => {
  it('requires a non-blank message_id and bounds limit', () => {
    expect(parseReadToolResultArgs({})).toEqual({ ok: false, error: 'invalid_arguments' });
    expect(parseReadToolResultArgs({ message_id: '  ' })).toEqual({ ok: false, error: 'invalid_arguments' });
    expect(parseReadToolResultArgs({ message_id: 'm1', limit: 20_001 })).toEqual({ ok: false, error: 'invalid_arguments' });
    expect(parseReadToolResultArgs({ message_id: 'm1', offset: -1 })).toEqual({ ok: false, error: 'invalid_arguments' });
    expect(parseReadToolResultArgs({ message_id: 'm1' })).toEqual({ ok: true, value: { messageId: 'm1' } });
  });
});

describe('readToolResultText', () => {
  it('pages through the serialized result', () => {
    const out = readToolResultText(result, { messageId: 'm1', offset: 0, limit: 100 });
    expect(out.total_characters).toBeGreaterThan(10_000);
    expect(out.returned_characters).toBe(100);
    expect(out.next_offset).toBe(100);
    expect(out.text).toHaveLength(100);
  });

  it('returns matches with context and caps the count', () => {
    const out = readToolResultText(result, { messageId: 'm1', query: 'calculator' });
    expect(out.match_count).toBe(1);
    expect(out.matches[0].context.toLowerCase()).toContain('calculator');
    expect(out.truncated).toBe(false);
  });

  it('returns an empty match list for a miss, not an error', () => {
    const out = readToolResultText(result, { messageId: 'm1', query: 'absent' });
    expect(out.match_count).toBe(0);
    expect(out.matches).toEqual([]);
  });

  it('sets truncated when more than 25 matches exist', () => {
    const many = { body: 'needle '.repeat(100) };
    const out = readToolResultText(many, { messageId: 'm1', query: 'needle' });
    expect(out.matches).toHaveLength(25);
    expect(out.truncated).toBe(true);
  });
});
