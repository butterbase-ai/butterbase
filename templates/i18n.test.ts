import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as support from './butterSupport/frontend/src/i18n/core.ts';
import * as crm from './butterbaseCRM/frontend/src/i18n/core.ts';
import * as scaffold from '../packages/cli/templates/react-vite/src/i18n/core.ts';
import { BUILTIN_FIELDS, applyBuiltinFilter, fieldDisplayLabel, formatFilterChip } from './butterbaseCRM/frontend/src/lib/filterDsl.ts';

const locales = [support, crm, scaffold];
afterEach(() => { for (const locale of locales) locale.setUiLocale('en'); });
for (const [index, locale] of locales.entries()) {
  test(`locale ${index}: English default, explicit Japanese and lossless interpolation`, () => {
    assert.equal(locale.getUiLocale(), 'en');
    assert.equal(locale.uiText('Email'), 'Email');
    locale.setUiLocale('ja');
    assert.equal(locale.uiText('Email'), 'メール');
    assert.equal(locale.uiText('Uncatalogued customer text / $' + '{0}'), 'Uncatalogued customer text / $' + '{0}');
    assert.equal(locale.uiText('toString'), 'toString');
    assert.equal(locale.uiMessage`Raw ${'$' + '{0}'} ${null} ${undefined}`, 'Raw $' + '{0} null undefined');
  });
  test(`locale ${index}: switching notifies subscribed screens and unsubscribe works`, () => {
    let notifications = 0;
    const unsubscribe = locale.subscribeUiLocale(() => notifications++);
    locale.setUiLocale('ja');
    locale.setUiLocale('ja');
    assert.equal(notifications, 1);
    unsubscribe();
    locale.setUiLocale('en');
    assert.equal(notifications, 1);
  });
}
test('presentation leaves field identifiers, filters and custom names intact', () => {
  const before = JSON.stringify(BUILTIN_FIELDS);
  assert.equal(crm.uiText('Title', 'Job title'), 'Title');
  crm.setUiLocale('ja');
  assert.equal(crm.uiText('Title', 'Job title'), '役職');
  assert.equal(JSON.stringify(BUILTIN_FIELDS), before);
  assert.equal(fieldDisplayLabel({ label: 'Name', builtIn: true }), '名前');
  assert.equal(fieldDisplayLabel({ label: 'Name', builtIn: false }), 'Name');
  assert.equal(fieldDisplayLabel(BUILTIN_FIELDS.people.find(field => field.slug === 'title')!), '役職');
  assert.equal(fieldDisplayLabel(BUILTIN_FIELDS.meetings.find(field => field.slug === 'title')!), 'タイトル');
  assert.equal(formatFilterChip({ field: 'name', op: 'eq', value: 'Cancelled / $' + '{0}' }, BUILTIN_FIELDS.companies), '名前 = Cancelled / $' + '{0}');
  const calls: unknown[] = [];
  const query: any = { eq: (...args: unknown[]) => { calls.push(args); return query; } };
  applyBuiltinFilter(query, { field: 'name', op: 'eq', value: 'Cancelled / 日本語' });
  assert.deepEqual(calls, [['name', 'Cancelled / 日本語']]);
});
test('unavailable localStorage does not prevent language switching', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
  try { support.setUiLocale('ja'); assert.equal(support.getUiLocale(), 'ja'); }
  finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('embed initial language respects an existing visitor choice', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } });
  try {
    support.initializeUiLocale('ja');
    assert.equal(support.getUiLocale(), 'ja');
    support.setUiLocale('en');
    support.initializeUiLocale('ja');
    assert.equal(support.getUiLocale(), 'en');
    assert.equal(saved.get(support.languageStorageKey), 'en');
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
