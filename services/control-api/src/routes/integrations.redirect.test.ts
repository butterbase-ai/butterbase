import { describe, it, expect } from 'vitest';
import { withStatusParams } from './integrations.js';

describe('withStatusParams', () => {
  it('appends params with ? on a query-free URL', () => {
    const out = withStatusParams('https://x/auth/callback', {
      status: 'connected',
      toolkit: 'googlesuper',
    });
    const url = new URL(out);
    expect(url.searchParams.get('status')).toBe('connected');
    expect(url.searchParams.get('toolkit')).toBe('googlesuper');
  });

  it('appends with & when the URL already has a query string (regression: ?integration=x?status=y)', () => {
    const out = withStatusParams('https://x/auth/callback?integration=googlesuper', {
      status: 'connected',
      toolkit: 'googlesuper',
    });
    expect(out).not.toMatch(/googlesuper\?status/);
    const url = new URL(out);
    expect(url.searchParams.get('integration')).toBe('googlesuper');
    expect(url.searchParams.get('status')).toBe('connected');
    expect(url.searchParams.get('toolkit')).toBe('googlesuper');
  });

  it('overwrites a colliding existing status param rather than duplicating', () => {
    const out = withStatusParams('https://x/cb?status=pending', { status: 'connected' });
    const url = new URL(out);
    expect(url.searchParams.getAll('status')).toEqual(['connected']);
  });

  it('preserves the fragment', () => {
    const out = withStatusParams('https://x/cb?a=1#section', { status: 'connected' });
    const url = new URL(out);
    expect(url.hash).toBe('#section');
    expect(url.searchParams.get('a')).toBe('1');
    expect(url.searchParams.get('status')).toBe('connected');
  });

  it('URL-encodes param values that contain special characters', () => {
    const out = withStatusParams('https://x/cb', { message: 'app mismatch & co' });
    const url = new URL(out);
    expect(url.searchParams.get('message')).toBe('app mismatch & co');
  });
});
