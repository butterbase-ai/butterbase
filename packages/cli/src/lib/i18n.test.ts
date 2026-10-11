import { afterEach, describe, expect, it } from 'vitest';
import { getCliLocale, msg, setCliLocale, text } from './i18n.js';
import { japaneseMessages } from './i18n/ja.js';

// English plurals are omitted where Japanese uses a counter instead.
const pluralKeys = new Set(['\n(${0} row${1})', '\n(${0} variable${1})', '\n(${0} key${1})', 'Returned ${0} result${1}']);
afterEach(() => setCliLocale('en'));

describe('CLI presentation catalog', () => {
  it('keeps English as the default and preserves interpolation values once', () => {
    expect(getCliLocale()).toBe('en');
    const name = '${0} / こんにちは';
    expect(msg`Fetching agent "${name}"...`).toBe(`Fetching agent "${name}"...`);
    setCliLocale('ja');
    expect(msg`Fetching agent "${name}"...`).toContain(name);
    expect(msg`Custom ${null} ${undefined}`).toBe('Custom null undefined');
    expect(text('an unknown message')).toBe('an unknown message');
  });

  it('does not lose or invent interpolation arguments or command flags', () => {
    const placeholders = (s: string) => [...new Set(s.match(/\$\{\d+\}/g) ?? [])].sort();
    for (const [source, translated] of Object.entries(japaneseMessages)) {
      const expected = placeholders(source);
      expect(placeholders(translated).filter(x => !expected.includes(x)), source).toEqual([]);
      if (!pluralKeys.has(source)) expect(placeholders(translated), source).toEqual(expected);
      for (const flag of source.match(/--[a-z][a-z-]*/g) ?? []) expect(translated, source).toContain(flag);
    }
  });
});
