import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerQueryAuditLogs } from '../tools/query-audit-logs.js';
import * as apiClient from '../api-client.js';

vi.mock('../api-client.js');

describe('query_audit_logs cursor', () => {
  let server: McpServer;
  let call: (args: Record<string, unknown>) => Promise<any>;
  const apiGetMock = vi.mocked(apiClient.apiGet);

  beforeEach(() => {
    vi.clearAllMocks();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    registerQueryAuditLogs(server);
    call = (args) => (server as any)._registeredTools['query_audit_logs'].handler(args);
  });

  it('advertises a cursor input', () => {
    const tool = (server as any)._registeredTools['query_audit_logs'];
    expect(Object.keys(tool.inputSchema.shape)).toContain('cursor');
  });

  it('passes the cursor through and returns nextCursor unchanged', async () => {
    const response = { logs: [], total: 1, limit: 2, offset: 0, nextCursor: 'cur_2', nextOffset: null };
    apiGetMock.mockResolvedValue(response);
    const out = await call({ app_id: 'app_1', cursor: 'cur_1', limit: 2 });
    const url = String(apiGetMock.mock.calls[0][0]);
    expect(url).toContain('/v1/app_1/audit-logs?');
    expect(url).toContain('cursor=cur_1');
    expect(url).toContain('limit=2');
    expect(JSON.parse(out.content[0].text)).toEqual(response);
  });
});
