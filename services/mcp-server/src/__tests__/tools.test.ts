import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createButterbaseMcpServer } from '../create-server.js';

async function createConnectedPair() {
  const server = await createButterbaseMcpServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client };
}

describe('MCP Server Tools', () => {
  it('registers all tools', async () => {
    const { client } = await createConnectedPair();
    const result = await client.listTools();

    const toolNames = result.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      'butterbase_docs',
      'create_frontend_deployment',
      'deploy_function',
      'init_app',
      'insert_row',
      'invoke_function',
      'list_regions',
      'manage_ai',
      'manage_api_keys',
      'manage_app',
      'manage_auth_config',
      'manage_auth_users',
      'manage_billing',
      'manage_durable_objects',
      'manage_edge_ssr',
      'manage_frontend',
      'manage_function',
      'manage_integrations',
      'manage_kv',
      'manage_migrations',
      'manage_oauth',
      'manage_rag_content',
      'manage_realtime',
      'manage_rls',
      'manage_schema',
      'manage_storage',
      'move_app',
      'move_app_status',
      'prep_and_submit_hackathon_entry',
      'query_audit_logs',
      'rag_query',
      'seed_database',
      'select_rows',
      'submit_suggestion',
      'teardown_source_replica',
      // submit_hackathon_entry is omitted because it is only shown when a
      // hackathon is within its active submission window (active-window cache
      // returns false in tests with no real server).
    ]);
  });

  it('init_app tool has correct input schema', async () => {
    const { client } = await createConnectedPair();
    const result = await client.listTools();
    const initTool = result.tools.find((t) => t.name === 'init_app');

    expect(initTool).toBeDefined();
    expect(initTool!.description).toContain('Create a new backend app');
    expect(initTool!.inputSchema.properties).toHaveProperty('name');
    expect(initTool!.inputSchema.required).toContain('name');
  });

  it('manage_schema tool has action enum and schema input', async () => {
    const { client } = await createConnectedPair();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'manage_schema');

    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties).toHaveProperty('app_id');
    expect(tool!.inputSchema.properties).toHaveProperty('action');
    expect(tool!.inputSchema.properties).toHaveProperty('schema');
    expect(tool!.inputSchema.required).toContain('app_id');
    expect(tool!.inputSchema.required).toContain('action');
    const actionProp = (tool!.inputSchema.properties as Record<string, { enum?: string[] }>).action;
    expect(actionProp.enum).toEqual(['get', 'apply', 'dry_run', 'list_migrations']);
  });

  it('manage_app "list" action has no required app_id (app_id is optional)', async () => {
    const { client } = await createConnectedPair();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'manage_app');

    expect(tool).toBeDefined();
    // app_id is optional in manage_app (list action does not need it)
    const required: string[] = (tool!.inputSchema.required as string[] | undefined) ?? [];
    expect(required).not.toContain('app_id');
  });

  it('manage_app exposes the consolidated actions', async () => {
    const { client } = await createConnectedPair();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'manage_app');
    expect(tool).toBeDefined();
    const actions = (tool!.inputSchema as unknown as { properties: { action: { enum: string[] } } })
      .properties.action.enum;
    expect(actions.sort()).toEqual([
      'delete', 'get_config', 'list', 'pause', 'secure', 'update_access_mode', 'update_cors',
    ]);
    const names = result.tools.map((t) => t.name);
    for (const removed of [
      'list_apps', 'delete_app', 'pause_app', 'get_app_config',
      'update_app_access_mode', 'secure_app', 'update_cors',
    ]) {
      expect(names).not.toContain(removed);
    }
  });

  it('manage_function exposes the consolidated actions', async () => {
    const { client } = await createConnectedPair();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'manage_function');
    expect(tool).toBeDefined();
    const actions = ((tool!.inputSchema as unknown) as { properties: { action: { enum: string[] } } })
      .properties.action.enum;
    expect(actions.sort()).toEqual(['delete', 'get_logs', 'list', 'update_env']);
    const names = result.tools.map((t) => t.name);
    for (const removed of ['list_functions', 'delete_function', 'get_function_logs', 'update_function_env']) {
      expect(names).not.toContain(removed);
    }
  });

  it('manage_frontend exposes the consolidated actions', async () => {
    const { client } = await createConnectedPair();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'manage_frontend');
    expect(tool).toBeDefined();
    const actions = ((tool!.inputSchema as unknown) as { properties: { action: { enum: string[] } } })
      .properties.action.enum;
    expect(actions.sort()).toEqual([
      'configure_custom_domain', 'create_from_source', 'list_deployments',
      'set_env', 'start_deployment', 'start_from_source',
    ]);
    const names = result.tools.map((t) => t.name);
    for (const removed of [
      'start_frontend_deployment', 'list_frontend_deployments',
      'deploy_frontend_from_source', 'set_frontend_env', 'configure_custom_domain',
    ]) {
      expect(names).not.toContain(removed);
    }
  });

  it('manage_auth_config exposes the consolidated actions', async () => {
    const { client } = await createConnectedPair();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'manage_auth_config');
    expect(tool).toBeDefined();
    const actions = ((tool!.inputSchema as unknown) as { properties: { action: { enum: string[] } } })
      .properties.action.enum;
    expect(actions.sort()).toEqual(['configure_auth_hook', 'generate_service_key', 'update_jwt']);
    const names = result.tools.map((t) => t.name);
    for (const removed of ['configure_auth_hook', 'update_jwt_config', 'generate_service_key']) {
      expect(names).not.toContain(removed);
    }
  });

  it('manage_rag_content exposes the consolidated actions', async () => {
    const { client } = await createConnectedPair();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'manage_rag_content');
    expect(tool).toBeDefined();
    const actions = ((tool!.inputSchema as unknown) as { properties: { action: { enum: string[] } } })
      .properties.action.enum;
    // Must include at least these — additional actions are fine if originals exposed them
    expect(actions).toContain('create_collection');
    expect(actions).toContain('list_collections');
    expect(actions).toContain('get_collection');
    expect(actions).toContain('delete_collection');
    expect(actions).toContain('ingest_document');
    expect(actions).toContain('list_documents');
    expect(actions).toContain('get_document_status');
    expect(actions).toContain('delete_document');
    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain('rag_collections');
    expect(names).not.toContain('rag_documents');
    expect(names).toContain('rag_query');
  });

  it('manage_integrations exposes the consolidated actions', async () => {
    const { client } = await createConnectedPair();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'manage_integrations');
    expect(tool).toBeDefined();
    const actions = ((tool!.inputSchema as unknown) as { properties: { action: { enum: string[] } } })
      .properties.action.enum;
    expect(actions.sort()).toEqual([
      'configure', 'disable', 'execute_action', 'list_available', 'list_connected', 'list_tools',
    ]);
    const names = result.tools.map((t) => t.name);
    for (const removed of [
      'configure_integration', 'list_available_integrations',
      'list_connected_accounts', 'list_integration_tools', 'execute_integration_action',
    ]) {
      expect(names).not.toContain(removed);
    }
  });

  it('butterbase_docs returns documentation without calling the network', async () => {
    const { client } = await createConnectedPair();
    const out = await client.callTool({
      name: 'butterbase_docs',
      arguments: { topic: 'overview' },
    });
    const text = (out.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    expect(text).toContain('Butterbase');
    expect(text).toContain('Declarative schema');
  });
});
