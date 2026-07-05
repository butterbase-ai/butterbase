import { describe, it, expect } from 'vitest';
import { validateEnvKeys } from './env-vars.js';

describe('validateEnvKeys', () => {
  it('accepts non-reserved keys', () => {
    expect(validateEnvKeys(['STRIPE_SECRET', 'foo_bar', 'X'])).toBeNull();
  });
  it('rejects BUTTERBASE_ prefix', () => {
    expect(validateEnvKeys(['OK', 'BUTTERBASE_APP_ID'])).toEqual({
      code: 'reserved_key_prefix', key: 'BUTTERBASE_APP_ID',
    });
  });
  it('is case-insensitive', () => {
    expect(validateEnvKeys(['butterbase_x'])).toEqual({
      code: 'reserved_key_prefix', key: 'butterbase_x',
    });
  });
  it('accepts empty list', () => {
    expect(validateEnvKeys([])).toBeNull();
  });
});
