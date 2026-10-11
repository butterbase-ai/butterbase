import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';

async function page(search = '', host = 'fixture.butterbase.dev') {
  const response = await worker.fetch(new Request('https://fixture.butterbase.dev/' + search, { headers: { host } }));
  return { response, html: await response.text() };
}

test('defaults to English and falls back for unsupported language values', async () => {
  const english = (await page()).html;
  assert.match(english, /<html lang="en">/);
  assert.match(english, /<h2>Your API<\/h2>/);
  for (const value of ['en', 'fr', 'JA', '__proto__', '%3Cscript%3E']) {
    assert.equal((await page('?lang=' + value)).html, english);
  }
});

test('serves Japanese while retaining the same API and code sample', async () => {
  const english = await page(); const japanese = await page('?lang=ja');
  assert.match(japanese.html, /<html lang="ja">/);
  assert.match(japanese.html, /<h2>アプリのAPI<\/h2>/);
  assert.match(japanese.html, /フロントエンドをデプロイして/);
  assert.equal(japanese.html.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)[1], english.html.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)[1]);
  assert.match(japanese.html, /href="\?lang=ja" lang="ja" hreflang="ja" aria-current="page"/);
  assert.equal(japanese.response.status, 200);
  assert.equal(japanese.response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(japanese.response.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(japanese.response.headers.get('set-cookie'), null);
});

test('keeps host-derived app text escaped in both languages and handles no Host', async () => {
  for (const search of ['', '?lang=ja']) {
    const { html } = await page(search, '<script>fixture</script>.butterbase.dev');
    assert.ok(!html.includes('<script>'));
    assert.match(html, /<h1>&lt;script&gt;fixture&lt;\/script&gt;<\/h1>/);
    assert.match((await page(search, '')).html, /<h1>your-app<\/h1>/);
  }
});
