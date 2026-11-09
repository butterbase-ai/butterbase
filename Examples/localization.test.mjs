import { test } from 'node:test';
import assert from 'node:assert/strict';

// Use fixture storage so these checks never touch a browser/profile token store.
const fixtureStorage = new Map();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: key => fixtureStorage.get(key) ?? null,
  setItem: (key, value) => fixtureStorage.set(key, value),
} });
const modules = await Promise.all([
  import('./todo-2026-04-02/frontend/src/i18n-core.mjs'),
  import('./grocery-list-2026-04-03/frontend/src/i18n-core.mjs'),
]);

test('both standalone examples use the same reviewed display vocabulary', () => {
  assert.deepEqual(modules[0].translations, modules[1].translations);
});
for (const [index, core] of modules.entries()) {
  test(`example ${index}: defaults to English and supports every Japanese display label`, () => {
    assert.equal(core.getLocale(), 'en');
    for (const source of Object.keys(core.translations)) assert.equal(core.text(source), source);
    core.setLocale('ja');
    for (const source of Object.keys(core.translations)) assert.equal(core.text(source), core.translations[source]);
    for (const raw of ['fixture user content', 'user@example.com', '__proto__', 'constructor']) assert.equal(core.text(raw), raw);
  });
  test(`example ${index}: persists selection, notifies subscribers and handles unavailable storage`, async () => {
    let changes = 0; const unsubscribe = core.subscribe(() => { changes++; });
    core.setLocale('en'); core.setLocale('ja'); unsubscribe(); core.setLocale('en');
    assert.equal(changes, 2); assert.equal(fixtureStorage.get('butterbase-example-language'), 'en');
    core.setLocale('ja');
    const url = new URL(index === 0 ? './todo-2026-04-02/frontend/src/i18n-core.mjs' : './grocery-list-2026-04-03/frontend/src/i18n-core.mjs', import.meta.url);
    url.search = '?restored=' + index;
    const restored = await import(url.href); assert.equal(restored.getLocale(), 'ja');
    const storage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('fixture storage denied'); } });
    assert.doesNotThrow(() => restored.setLocale('ja'));
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    for (const value of ['fr', '__proto__', 'JA']) { core.setLocale(value); assert.equal(core.getLocale(), 'en'); }
  });
  test(`example ${index}: changes date presentation and marks only local fallback errors`, () => {
    const timestamp = '2026-01-02T03:04:05Z';
    core.setLocale('ja'); assert.equal(core.formatDate(timestamp), new Date(timestamp).toLocaleString('ja-JP'));
    core.setLocale('en'); assert.equal(core.formatDate(timestamp), new Date(timestamp).toLocaleString());
    assert.ok(new core.UiError('Login failed') instanceof core.UiError);
    assert.ok(!(new Error('Login failed') instanceof core.UiError));
    assert.equal(new core.UiError('Login failed').message, 'Login failed');
  });
}
