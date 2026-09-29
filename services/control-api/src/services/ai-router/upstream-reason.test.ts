import { describe, it, expect } from 'vitest';
import { upstreamReason } from './upstream-reason.js';

describe('upstreamReason', () => {
  it('extracts error.message from an OpenRouter-style JSON body', () => {
    expect(upstreamReason(JSON.stringify({ error: { message: 'questions.x.type is invalid' } }))).toBe('questions.x.type is invalid');
  });
  it('extracts a top-level message', () => {
    expect(upstreamReason(JSON.stringify({ message: 'bad state' }))).toBe('bad state');
  });
  it('truncates to 500 characters', () => {
    expect(upstreamReason(JSON.stringify({ error: { message: 'x'.repeat(900) } }))).toHaveLength(500);
  });
  it('falls back to a generic sentence for non-JSON or message-less bodies', () => {
    expect(upstreamReason('<html>502</html>')).toBe('The model provider rejected the request.');
    expect(upstreamReason(JSON.stringify({ error: { code: 400 } }))).toBe('The model provider rejected the request.');
  });
});
