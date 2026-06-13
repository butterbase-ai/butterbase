import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerManageAgents } from '../tools/manage-agents.js';
import * as apiClient from '../api-client.js';

vi.mock('../api-client.js');

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

function getHandler(server: McpServer, name: string): ToolHandler {
  // McpServer stores registered tools on _registeredTools[name].handler
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools;
  const entry = tools[name];
  if (!entry) throw new Error(`tool ${name} not registered`);
  return entry.handler;
}

// Minimal graph_spec fixture that satisfies graphSpecSchema
const minimalSpec = {
  spec_version: '1' as const,
  entry: 'end',
  nodes: { end: { type: 'end', output_template: '{{result}}' } },
  edges: [],
  tools: { builtin: [], mcp_servers: [], functions: [] },
  limits: {
    max_steps: 10,
    max_tool_calls: 20,
    max_parallel_tools: 4,
    timeout_seconds: 30,
    human_timeout_seconds: 300,
  },
};

describe('manage_agents', () => {
  let server: McpServer;
  beforeEach(() => {
    vi.clearAllMocks();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    registerManageAgents(server);
  });

  it('action="list" GETs /v1/{app_id}/agents', async () => {
    vi.mocked(apiClient.apiGet).mockResolvedValue([{ name: 'a1' }]);
    const handler = getHandler(server, 'manage_agents');
    const result = await handler({ action: 'list', app_id: 'app_abc' });
    expect(apiClient.apiGet).toHaveBeenCalledWith('/v1/app_abc/agents');
    expect(JSON.parse(result.content[0].text)).toEqual([{ name: 'a1' }]);
  });

  it('action="get" GETs /v1/{app_id}/agents/{name}', async () => {
    vi.mocked(apiClient.apiGet).mockResolvedValue({ name: 'foo', status: 'active' });
    const handler = getHandler(server, 'manage_agents');
    const result = await handler({ action: 'get', app_id: 'app_abc', name: 'foo' });
    expect(apiClient.apiGet).toHaveBeenCalledWith('/v1/app_abc/agents/foo');
    expect(JSON.parse(result.content[0].text)).toEqual({ name: 'foo', status: 'active' });
  });

  it('action="get" without name returns isError', async () => {
    const handler = getHandler(server, 'manage_agents');
    const result = await handler({ action: 'get', app_id: 'app_abc' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"name" is required');
  });

  it('action="create" POSTs /v1/{app_id}/agents with name, graph_spec, display_name', async () => {
    vi.mocked(apiClient.apiPost).mockResolvedValue({ name: 'foo', id: 'ag_1' });
    const handler = getHandler(server, 'manage_agents');
    const result = await handler({
      action: 'create',
      app_id: 'app_abc',
      name: 'foo',
      graph_spec: minimalSpec,
      display_name: 'Foo',
    });
    expect(apiClient.apiPost).toHaveBeenCalledWith('/v1/app_abc/agents', expect.objectContaining({
      name: 'foo',
      graph_spec: expect.objectContaining({ spec_version: '1' }),
      display_name: 'Foo',
    }));
    expect(JSON.parse(result.content[0].text)).toEqual({ name: 'foo', id: 'ag_1' });
  });

  it('action="create" with missing name returns isError with "name" is required message', async () => {
    const handler = getHandler(server, 'manage_agents');
    const result = await handler({ action: 'create', app_id: 'app_abc', graph_spec: minimalSpec });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"name" is required');
  });

  it('action="create" with invalid name (uppercase) returns isError with regex message', async () => {
    const handler = getHandler(server, 'manage_agents');
    const result = await handler({
      action: 'create',
      app_id: 'app_abc',
      name: 'InvalidName',
      graph_spec: minimalSpec,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('/^[a-z0-9][a-z0-9_-]{0,63}$/');
  });

  it('action="update" PATCHes /v1/{app_id}/agents/{name} with body', async () => {
    vi.mocked(apiClient.apiPatch).mockResolvedValue({ name: 'foo', display_name: 'Renamed' });
    const handler = getHandler(server, 'manage_agents');
    const result = await handler({
      action: 'update',
      app_id: 'app_abc',
      name: 'foo',
      display_name: 'Renamed',
    });
    expect(apiClient.apiPatch).toHaveBeenCalledWith('/v1/app_abc/agents/foo', { display_name: 'Renamed' });
    expect(JSON.parse(result.content[0].text)).toEqual({ name: 'foo', display_name: 'Renamed' });
  });

  it('action="update" without name returns isError', async () => {
    const handler = getHandler(server, 'manage_agents');
    const result = await handler({ action: 'update', app_id: 'app_abc', display_name: 'Renamed' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"name" is required');
  });

  it('action="delete" DELETEs /v1/{app_id}/agents/{name} and response includes "deleted"', async () => {
    vi.mocked(apiClient.apiDelete).mockResolvedValue(undefined);
    const handler = getHandler(server, 'manage_agents');
    const result = await handler({ action: 'delete', app_id: 'app_abc', name: 'foo' });
    expect(apiClient.apiDelete).toHaveBeenCalledWith('/v1/app_abc/agents/foo');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('deleted');
  });

  it('action="delete" without name returns isError', async () => {
    const handler = getHandler(server, 'manage_agents');
    const result = await handler({ action: 'delete', app_id: 'app_abc' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"name" is required');
  });

  it('action="validate" with a valid spec POSTs to validate endpoint', async () => {
    vi.mocked(apiClient.apiPost).mockResolvedValue({ valid: true });
    const handler = getHandler(server, 'manage_agents');
    const result = await handler({ action: 'validate', app_id: 'app_abc', graph_spec: minimalSpec });
    expect(apiClient.apiPost).toHaveBeenCalledWith('/v1/app_abc/agents/_/validate', { graph_spec: minimalSpec });
    expect(JSON.parse(result.content[0].text)).toEqual({ valid: true });
  });

  it('action="validate" with an invalid spec returns { valid: false, issues: [...] } without calling apiPost', async () => {
    const fetchSpy = vi.mocked(apiClient.apiPost);
    const handler = getHandler(server, 'manage_agents');
    const result = await handler({
      action: 'validate',
      app_id: 'app_abc',
      graph_spec: { spec_version: '1' }, // missing required fields
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.valid).toBe(false);
    expect(parsed.issues).toBeDefined();
  });

  it('action="validate" without graph_spec returns isError', async () => {
    const handler = getHandler(server, 'manage_agents');
    const result = await handler({ action: 'validate', app_id: 'app_abc' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"graph_spec" is required');
  });
});
