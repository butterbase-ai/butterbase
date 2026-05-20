import { describe, it, expect } from 'vitest';
import { parseKvValue } from './index.js';

describe('parseKvValue', () => {
  const env = { BUTTERBASE_REGION: 'us-east-1' };

  it('returns null for missing value', () => {
    expect(parseKvValue(null, env)).toBeNull();
  });

  it('parses JSON value', () => {
    expect(parseKvValue('{"appId":"a","region":"eu-west-1"}', env)).toEqual({ appId: 'a', region: 'eu-west-1' });
  });

  it('falls back to local region for JSON without region', () => {
    expect(parseKvValue('{"appId":"a"}', env)).toEqual({ appId: 'a', region: 'us-east-1' });
  });

  it('treats legacy string value as local region', () => {
    expect(parseKvValue('legacy-app-id', env)).toEqual({ appId: 'legacy-app-id', region: 'us-east-1' });
  });
});
