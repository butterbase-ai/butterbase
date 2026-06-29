import { describe, it, expect } from 'vitest';
import { normalizeLinkedinUrl } from './url.js';

describe('normalizeLinkedinUrl', () => {
  it('lowercases host + path', () => {
    expect(normalizeLinkedinUrl('https://WWW.LinkedIn.com/in/JohnDoe'))
      .toBe('https://www.linkedin.com/in/johndoe');
  });
  it('strips trailing slash', () => {
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/jane/'))
      .toBe('https://www.linkedin.com/in/jane');
  });
  it('strips query + hash', () => {
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/jane?utm=x#bio'))
      .toBe('https://www.linkedin.com/in/jane');
  });
  it('throws on non-LinkedIn host', () => {
    expect(() => normalizeLinkedinUrl('https://twitter.com/in/jane')).toThrow();
  });
  it('throws on missing /in/ path', () => {
    expect(() => normalizeLinkedinUrl('https://www.linkedin.com/company/x')).toThrow();
  });
});
