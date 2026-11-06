import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createButterbaseMcpServer } from '../create-server.js';
afterEach(() => { vi.unstubAllEnvs(); });
describe('Office optional cloud registration', () => {
  it('loads the private registrar and includes manage_office in tools/list', async () => {
    const server = await createButterbaseMcpServer({ loadOfficeOverlay: async () => ({ registerOfficeMcpTools: server => {
      server.registerTool('manage_office', { inputSchema: { action: z.literal('status') } }, async () => ({ content: [] }));
    } }) });
    const client = new Client({ name: 'test', version: '1' }); const [a,b] = InMemoryTransport.createLinkedPair();
    try { await Promise.all([server.connect(b), client.connect(a)]);
      expect((await client.listTools()).tools.some(t => t.name === 'manage_office')).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
  it('keeps OSS startup valid when the optional overlay is absent', async () => {
    const server = await createButterbaseMcpServer({ loadOfficeOverlay: async () => { throw Object.assign(new Error('absent'), { code: 'ERR_MODULE_NOT_FOUND' }); } });
    await server.close();
  });
  it('fails required cloud startup instead of silently shipping a missing tool', async () => {
    vi.stubEnv('OFFICE_MCP_REQUIRED', '1');
    await expect(createButterbaseMcpServer({ loadOfficeOverlay: async () => { throw new Error('registration failed'); } })).rejects.toThrow('Office MCP registration failed');
  });
});
