import { describe, it, expect } from 'vitest';
import * as shared from './index.js';

describe('shared package surface', () => {
  it('exports error code constants', () => {
    expect(shared.ErrorCodes.VALIDATION_INVALID_SCHEMA).toBe('VALIDATION_INVALID_SCHEMA');
    expect(shared.ErrorCodes.RESOURCE_NOT_FOUND).toBe('RESOURCE_NOT_FOUND');
    expect(shared.ErrorCodes.QUOTA_FILE_SIZE_EXCEEDED).toBe('QUOTA_FILE_SIZE_EXCEEDED');
  });

  it('exports region utilities', () => {
    expect(typeof shared.parseRegions).toBe('function');
  });

  it('isAgentFriendlyError detects backend error shape', () => {
    expect(shared.isAgentFriendlyError({ error: { code: 'X', message: 'y', remediation: 'z' } })).toBe(true);
    expect(shared.isAgentFriendlyError({ error: { code: 'X' } })).toBe(false);
    expect(shared.isAgentFriendlyError(null)).toBe(false);
    expect(shared.isAgentFriendlyError({})).toBe(false);
  });
});
