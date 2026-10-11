import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
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
  it('preserves the complete baseline English output byte for byte', () => {
    expect(createHash('sha256').update(getUserDocumentation('all')).digest('hex')).toBe('55c885918f854ba95e7cbe30eff052f65a025273afa16e3274d91e98e09e723b');
    for (const topic of DOC_TOPICS) expect(getUserDocumentation(topic)).toBe(getUserDocumentation(topic, 'en'));
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
