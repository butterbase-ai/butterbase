import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerDocs } from '../tools/docs.js';
import { DOC_TOPICS, getUserDocumentation, searchUserDocumentation } from '../docs/user-documentation.js';

async function withDocs(run: (client: Client) => Promise<void>) {
  const server = new McpServer({ name: 'docs-fixture', version: '1.0.0' });
  registerDocs(server);
  const client = new Client({ name: 'docs-client', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try { await Promise.all([server.connect(b), client.connect(a)]); await run(client); }
  finally { await Promise.all([client.close(), server.close()]); }
}
function text(result: any): string { return result.content.map((block: any) => block.text ?? '').join('\n'); }

describe('local Japanese MCP documentation', () => {
  it('keeps the default English output unchanged and selects Japanese only on request', () => {
    const english = getUserDocumentation('all');
    expect(english).toBe(getUserDocumentation('all', 'en'));
    expect(english).not.toBe(getUserDocumentation('all', 'ja'));
    for (const topic of DOC_TOPICS) expect(getUserDocumentation(topic)).toBe(getUserDocumentation(topic, 'en'));
    for (const topic of DOC_TOPICS.filter(topic => topic !== 'all')) expect(english).toContain(getUserDocumentation(topic));
  });
  it('returns Japanese for every existing topic and includes every section in all', () => {
    const all = getUserDocumentation('all', 'ja');
    expect(getUserDocumentation('functions', 'ja')).toContain('(https://docs.butterbase.ai/ja/core-concepts/durable-objects/#server-to-server-calls-into-durable-objects)');
    expect(all).not.toMatch(/(?<!!)\[[^\]]*\]\((?:\.\.?\/|\/ja\/|#)/);
    for (const topic of DOC_TOPICS.filter(topic => topic !== 'all')) {
      const doc = getUserDocumentation(topic, 'ja');
      expect(doc).toMatch(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
      expect(doc).not.toBe(getUserDocumentation(topic)); expect(all).toContain(doc);
    }
  });
  it('supports Japanese phrases, empty terms and a bounded result index', () => {
    const hits = searchUserDocumentation('ファイルのアップロード', 5, 'ja');
    expect(hits.length).toBeGreaterThan(0); expect(hits.some(hit => hit.topic === 'storage')).toBe(true);
    expect(searchUserDocumentation('の を に', 5, 'ja')).toEqual([]);
    expect(searchUserDocumentation('fixturexyz404', 5, 'ja')).toEqual([]);
    expect(searchUserDocumentation('認証', 2, 'ja').length).toBeLessThanOrEqual(2);
  });
  it('ranks the matching section first for ordinary Japanese questions', () => {
    const top = (query: string) => searchUserDocumentation(query, 5, 'ja').map(hit => hit.topic);
    expect(top('料金プランについて教えて')[0]).toBe('billing');
    expect(top('ストレージの署名付きURLについて')[0]).toBe('storage');
    expect(top('関数のタイムアウトはどこで設定しますか')[0]).toBe('functions');
    expect(top('カスタムドメインの設定をお願いします')[0]).toBe('frontend');
    expect(top('OAuthでログインを実装したい')[0]).toBe('auth');
    expect(top('認証の方法を教えてください')).toContain('auth');
  });
  it('exposes optional language and retains the read-only annotations', async () => {
    await withDocs(async client => {
      const { tools } = await client.listTools(); const docs = tools.find(tool => tool.name === 'butterbase_docs')!;
      expect((docs.inputSchema.properties!.language as any).enum).toEqual(['en', 'ja']);
      expect(docs.inputSchema.required ?? []).not.toContain('language');
      expect(docs.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    });
  });
  it('serves default English and explicit Japanese over a real MCP client', async () => {
    await withDocs(async client => {
      expect(text(await client.callTool({ name: 'butterbase_docs', arguments: { topic: 'auth' } }))).toBe(getUserDocumentation('auth'));
      expect(text(await client.callTool({ name: 'butterbase_docs', arguments: { topic: 'auth', language: 'ja' } }))).toBe(getUserDocumentation('auth', 'ja'));
    });
  });
  it('keeps exact-topic precedence and rejects unsupported languages', async () => {
    await withDocs(async client => {
      expect(text(await client.callTool({ name: 'butterbase_docs', arguments: { topic: 'storage', query: '認証', language: 'ja' } }))).toBe(getUserDocumentation('storage', 'ja'));
      const invalid = await client.callTool({ name: 'butterbase_docs', arguments: { topic: 'auth', language: 'fr' } });
      expect(invalid.isError).toBe(true);
    });
  });
  it('localizes search and no-match responses without changing the query value', async () => {
    await withDocs(async client => {
      const query = 'ファイルのアップロード';
      expect(text(await client.callTool({ name: 'butterbase_docs', arguments: { query, language: 'ja' } }))).toContain('「' + query + '」の検索結果');
      const miss = text(await client.callTool({ name: 'butterbase_docs', arguments: { query: 'fixturexyz404', language: 'ja' } }));
      expect(miss).toContain('「fixturexyz404」に一致する文書はありません'); expect(miss).toContain('storage');
    });
  });
});
