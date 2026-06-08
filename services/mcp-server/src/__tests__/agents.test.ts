import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('Agent CRUD tools', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('list_agents calls GET /v1/:appId/agents and returns the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ agents: [{ id: 'ag_1', name: 'my-agent', status: 'active' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    const result = await client.callTool({ name: 'list_agents', arguments: { app_id: 'app_abc123' } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/app_abc123/agents');
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined(); // GET has no explicit method

    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('');
    const parsed = JSON.parse(text);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0].name).toBe('my-agent');
  });

  it('get_agent calls GET /v1/:appId/agents/:name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ agent: { id: 'ag_1', name: 'my-agent', status: 'active' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    const result = await client.callTool({
      name: 'get_agent',
      arguments: { app_id: 'app_abc123', name: 'my-agent' },
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/app_abc123/agents/my-agent');

    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('');
    expect(JSON.parse(text).agent.name).toBe('my-agent');
  });

  it('create_agent calls POST /v1/:appId/agents with body', async () => {
    const agentPayload = {
      agent: { id: 'ag_2', name: 'new-agent', status: 'active' },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(agentPayload), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const minimalSpec = {
      spec_version: '1',
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

    const { client } = await createConnectedPair();
    await client.callTool({
      name: 'create_agent',
      arguments: {
        app_id: 'app_abc123',
        name: 'new-agent',
        graph_spec: minimalSpec,
        visibility: 'private',
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/app_abc123/agents');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe('new-agent');
    expect(body.graph_spec.spec_version).toBe('1');
    expect(body.visibility).toBe('private');
  });

  it('update_agent calls PATCH /v1/:appId/agents/:name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ agent: { id: 'ag_1', name: 'my-agent', status: 'disabled' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    await client.callTool({
      name: 'update_agent',
      arguments: { app_id: 'app_abc123', name: 'my-agent', status: 'disabled' },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/app_abc123/agents/my-agent');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string);
    expect(body.status).toBe('disabled');
  });

  it('delete_agent calls DELETE /v1/:appId/agents/:name and reports success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    const result = await client.callTool({
      name: 'delete_agent',
      arguments: { app_id: 'app_abc123', name: 'my-agent' },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/app_abc123/agents/my-agent');
    expect(init.method).toBe('DELETE');

    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('');
    expect(JSON.parse(text).success).toBe(true);
  });

  it('validate_agent_spec returns valid:false for a bad spec without hitting the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    const result = await client.callTool({
      name: 'validate_agent_spec',
      arguments: {
        app_id: 'app_abc123',
        // Missing required fields — should fail client-side parse
        graph_spec: { spec_version: '1' },
      },
    });

    // Client-side validation should catch this without a fetch call
    expect(fetchMock).not.toHaveBeenCalled();

    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('');
    const parsed = JSON.parse(text);
    expect(parsed.valid).toBe(false);
    expect(parsed.issues).toBeDefined();
  });
});
