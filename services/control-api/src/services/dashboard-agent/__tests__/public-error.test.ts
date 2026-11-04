import { describe, expect, it } from 'vitest';
import { publicAgentErrorMessage } from '../public-error.js';

describe('publicAgentErrorMessage', () => {
  it('explains an oversized model input instead of hiding it', () => {
    const message = 'gateway 400: {"error":{"code":"invalid_parameter_error","message":"Range of input length should be [1, 983616]"}}';
    expect(publicAgentErrorMessage(message)).toMatch(/too large/i);
  });

  it('keeps the generic message for unrelated failures', () => {
    expect(publicAgentErrorMessage('gateway 500: upstream unavailable')).toBe(
      'The operator could not complete this turn.',
    );
  });
});
