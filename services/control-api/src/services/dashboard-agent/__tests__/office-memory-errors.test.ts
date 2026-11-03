import { describe, expect, it } from 'vitest';
import { officeMemoryErrorPayload } from '../office-memory-types.js';

describe('officeMemoryErrorPayload', () => {
  it('names the required evidence for verification failures', () => {
    expect(officeMemoryErrorPayload('agent_memory_verification_required')).toEqual({
      code: 'agent_memory_verification_required',
      message: expect.stringContaining('payload.verification.evidence'),
      required: ['payload.verification.evidence'],
    });
  });

  it('never claims a record category is missing', () => {
    expect(officeMemoryErrorPayload('agent_memory_verification_required').message.toLowerCase()).not.toContain('category');
  });

  it('keeps scope failures accurate', () => {
    expect(officeMemoryErrorPayload('agent_memory_scope_mismatch').message).toContain('organization');
  });

  it('falls back without echoing the request', () => {
    expect(officeMemoryErrorPayload('unexpected')).toEqual({ code: 'unexpected', message: 'The memory request was rejected.' });
  });
});
