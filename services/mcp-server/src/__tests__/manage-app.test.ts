import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerManageApp } from '../tools/manage-app.js';
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

describe('manage_app: move actions', () => {
  let server: McpServer;
  beforeEach(() => {
    vi.clearAllMocks();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    registerManageApp(server);
  });

  it('action="move" POSTs /v1/apps/{app_id}/move with dest_region', async () => {
    vi.mocked(apiClient.apiPost).mockResolvedValue({ migration_id: 'mig_1', status: 'queued' });
    const handler = getHandler(server, 'manage_app');
    const result = await handler({ action: 'move', app_id: 'app_abc', dest_region: 'us-west-2' });
    expect(apiClient.apiPost).toHaveBeenCalledWith('/v1/apps/app_abc/move', { dest_region: 'us-west-2' });
    expect(JSON.parse(result.content[0].text).migration_id).toBe('mig_1');
  });

  it('action="move" without dest_region returns isError', async () => {
    const handler = getHandler(server, 'manage_app');
    const result = await handler({ action: 'move', app_id: 'app_abc' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/dest_region/);
  });

  it('action="move_status" GETs /v1/apps/{app_id}/migrations/{migration_id}', async () => {
    vi.mocked(apiClient.apiGet).mockResolvedValue({ current_step: 'dumping_data' });
    const handler = getHandler(server, 'manage_app');
    const result = await handler({ action: 'move_status', app_id: 'app_abc', migration_id: 'mig_1' });
    expect(apiClient.apiGet).toHaveBeenCalledWith('/v1/apps/app_abc/migrations/mig_1');
    expect(JSON.parse(result.content[0].text).current_step).toBe('dumping_data');
  });

  it('action="teardown_source_replica" DELETEs /v1/source-replicas/{migration_id}', async () => {
    vi.mocked(apiClient.apiDelete).mockResolvedValue({ status: 'torn_down' });
    const handler = getHandler(server, 'manage_app');
    const result = await handler({ action: 'teardown_source_replica', migration_id: 'mig_1' });
    expect(apiClient.apiDelete).toHaveBeenCalledWith('/v1/source-replicas/mig_1');
    expect(JSON.parse(result.content[0].text).status).toBe('torn_down');
  });
});

describe('manage_app: env actions', () => {
  let server: McpServer;
  beforeEach(() => {
    vi.clearAllMocks();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    registerManageApp(server);
  });

  it('action get_env returns { keys, updated_at }', async () => {
    vi.mocked(apiClient.apiGet).mockResolvedValue({ keys: ['A'], updatedAt: '2026-07-05T00:00:00Z' });
    const handler = getHandler(server, 'manage_app');
    const result = await handler({ action: 'get_env', app_id: 'app_abc' });
    expect(apiClient.apiGet).toHaveBeenCalledWith('/v1/app_abc/env');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.keys).toEqual(['A']);
    expect(parsed.updated_at).toBe('2026-07-05T00:00:00Z');
  });

  it('action update_env forwards body and returns invalidation summary', async () => {
    vi.mocked(apiClient.apiPatch).mockResolvedValue({
      message: 'ok',
      updatedKeys: ['A'],
      invalidated: { functions: ['hello'], count: 1 },
    });
    const handler = getHandler(server, 'manage_app');
    const result = await handler({ action: 'update_env', app_id: 'app_abc', env: { A: '1' } });
    expect(apiClient.apiPatch).toHaveBeenCalledWith('/v1/app_abc/env', { envVars: { A: '1' } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.updated_keys).toEqual(['A']);
    expect(parsed.invalidated.count).toBe(1);
  });

  it('action update_env rejects reserved keys before hitting control-api', async () => {
    const handler = getHandler(server, 'manage_app');
    const result = await handler({ action: 'update_env', app_id: 'app_abc', env: { BUTTERBASE_X: 'y' } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/reserved/i);
    expect(apiClient.apiPatch).not.toHaveBeenCalled();
  });
});
