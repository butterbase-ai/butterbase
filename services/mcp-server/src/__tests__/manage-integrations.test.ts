import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerIntegrations } from '../tools/integrations.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

function getHandler(server: McpServer, name: string): ToolHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools;
  const entry = tools[name];
  if (!entry) throw new Error(`tool ${name} not registered`);
  return entry.handler;
}

describe('manage_integrations execute_action tool name', () => {
  let server: McpServer;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    registerIntegrations(server);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ successful: true }) });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('accepts tool_slug as an alias for tool_name', async () => {
    const handler = getHandler(server, 'manage_integrations');
    const result = await handler({
      action: 'execute_action',
      app_id: 'app_x',
      tool_slug: 'GMAIL_SEND_EMAIL',
      params: { to: 'a@b.c' },
    });

    expect(result.isError).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v1/app_x/integrations/execute');
    expect(JSON.parse(init.body)).toMatchObject({
      toolName: 'GMAIL_SEND_EMAIL',
      params: { to: 'a@b.c' },
    });
  });

  it('still accepts tool_name', async () => {
    const handler = getHandler(server, 'manage_integrations');
    const result = await handler({
      action: 'execute_action',
      app_id: 'app_x',
      tool_name: 'GMAIL_SEND_EMAIL',
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ toolName: 'GMAIL_SEND_EMAIL' });
  });

  it('rejects execute_action with neither name', async () => {
    const handler = getHandler(server, 'manage_integrations');
    const result = await handler({ action: 'execute_action', app_id: 'app_x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('tool_slug');
  });
});
