import { describe, it, expect } from 'vitest';
import { userKey, isValidUserKey, parseUserKey } from './keys.js';

describe('userKey', () => {
  it('prefixes user keys with the app hash tag', () => {
    expect(userKey('app_abc', 'session:123')).toBe('{app_abc}:u:session:123');
  });
});

describe('isValidUserKey', () => {
  it('accepts allowed characters', () => {
    expect(isValidUserKey('session:user-1.token')).toBe(true);
    expect(isValidUserKey('a/b/c')).toBe(true);
  });
  it('rejects reserved underscore-prefixed keys', () => {
    expect(isValidUserKey('_meta')).toBe(false);
    expect(isValidUserKey('_foo')).toBe(false);
  });
  it('rejects empty', () => {
    expect(isValidUserKey('')).toBe(false);
  });
  it('rejects > 512 bytes', () => {
    expect(isValidUserKey('x'.repeat(513))).toBe(false);
    expect(isValidUserKey('x'.repeat(512))).toBe(true);
  });
  it('rejects disallowed characters', () => {
    expect(isValidUserKey('has space')).toBe(false);
    expect(isValidUserKey('has\n')).toBe(false);
    expect(isValidUserKey('has*')).toBe(false);
  });
});

describe('parseUserKey', () => {
  it('strips the hash-tag prefix', () => {
    expect(parseUserKey('{app_abc}:u:session:123')).toEqual({ appId: 'app_abc', userKey: 'session:123' });
  });
  it('returns null for malformed', () => {
    expect(parseUserKey('plain:key')).toBeNull();
  });
});
