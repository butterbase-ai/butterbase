import { describe, it, expect } from 'vitest';
import { renderError } from './errors';
import { ButterbaseError, AuthError } from '@butterbase/sdk';

// strip ANSI for assertions
const strip = (s: string) => s.replace(/\[[0-9;]*m/g, '');

describe('renderError', () => {
  it('formats a typed ButterbaseError with code/status/remediation', () => {
    const e = new AuthError('Bad key', 'AUTH_INVALID_API_KEY', 401, 'Check your token');
    const r = strip(renderError(e));
    expect(r).toContain('AuthError: Bad key');
    expect(r).toContain('code:        AUTH_INVALID_API_KEY');
    expect(r).toContain('status:      401');
    expect(r).toContain('remediation: Check your token');
  });

  it('formats a base ButterbaseError without remediation', () => {
    const e = new ButterbaseError('boom', 'HTTP_500', 500);
    const r = strip(renderError(e));
    expect(r).toContain('ButterbaseError: boom');
    expect(r).toContain('code:        HTTP_500');
    expect(r).not.toContain('remediation');
  });

  it('formats a plain Error', () => {
    const r = strip(renderError(new Error('plain')));
    expect(r).toBe('plain');
  });

  it('handles non-Error values', () => {
    expect(strip(renderError('oops'))).toBe('oops');
    expect(strip(renderError(42))).toBe('42');
  });
});
