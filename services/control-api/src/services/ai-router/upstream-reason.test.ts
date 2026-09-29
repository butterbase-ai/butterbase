import { describe, it, expect } from 'vitest';
import { upstreamReason } from './upstream-reason.js';

const body = (message: string) => JSON.stringify({ error: { message, code: 400 }, user_id: 'user_3BzzfM5aqHg5v6yNkWFi6n59qVv' });
const issues = (list: unknown[]) => body(JSON.stringify(list, null, 2));

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

  // Shapes below were captured live from POST /api/alpha/decisions on 2026-09-29.
  describe('validation issue arrays', () => {
    it('flattens issues into "path: message" pairs', () => {
      expect(upstreamReason(issues([
        { code: 'invalid_union', path: ['questions', 'q', 'criteria', 'true'], message: 'Invalid input' },
        { code: 'invalid_union', path: ['questions', 'q', 'criteria', 'false'], message: 'Invalid input' },
      ]))).toBe('questions.q.criteria.true: Invalid input; questions.q.criteria.false: Invalid input');
    });
    it('keeps the discriminator message that names the allowed question types', () => {
      expect(upstreamReason(issues([
        { code: 'invalid_union', errors: [], note: 'No matching discriminator', discriminator: 'type', options: ['noul', 'choice', 'score'],
          path: ['questions', 'q', 'type'], message: "Invalid discriminator value. Expected 'noul' | 'choice' | 'score'" },
      ]))).toBe("questions.q.type: Invalid discriminator value. Expected 'noul' | 'choice' | 'score'");
    });
    it('uses the message alone when the path is empty', () => {
      expect(upstreamReason(issues([{ code: 'custom', path: [], message: 'At least one question is required' }])))
        .toBe('At least one question is required');
    });
    it('leaves a JSON array that is not an issue list as scrubbed text', () => {
      expect(upstreamReason(body('[1, 2]'))).toBe('[1, 2]');
    });
  });

  describe('scrubbing', () => {
    it('replaces mentions of OpenRouter with a neutral phrase', () => {
      expect(upstreamReason(body('OpenRouter could not route this request (openrouter error).')))
        .toBe('The model provider could not route this request (the model provider error).');
    });
    it('removes openrouter.ai URLs', () => {
      expect(upstreamReason(body('See https://openrouter.ai/docs/guides/community/jev for the schema.')))
        .toBe('See the model provider documentation for the schema.');
    });
    it('redacts request, generation, user ids, UUIDs and API keys', () => {
      expect(upstreamReason(body(
        'Failed gen-dec-1790015143-AIaTutprXsJ5EwohRSjb for user_3BzzfM5aqHg5v6yNkWFi6n59qVv req_abc123XYZ 9b2f6c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b key sk-or-v1-deadbeefcafe',
      ))).toBe('Failed [id] for [id] [id] [id] key [redacted]');
    });
    it('never returns the top-level user_id even though the body carries one', () => {
      expect(upstreamReason(body('Model typesafe/nope does not exist'))).toBe('Model typesafe/nope does not exist');
    });
    it('leaves the chosen model vendor name alone', () => {
      const msg = 'Respan state must be a string or an object with only input (a message array) and output (a message)';
      expect(upstreamReason(body(msg))).toBe(msg);
    });
    it('scrubs inside flattened validation issues too', () => {
      expect(upstreamReason(issues([{ code: 'custom', path: ['state'], message: 'Rejected by OpenRouter for gen-abc123def456' }])))
        .toBe('state: Rejected by the model provider for [id]');
    });
  });
});
