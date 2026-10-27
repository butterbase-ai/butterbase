import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerManageAi } from './manage-ai.js';

const declarations = [{ path: '/input_images/0', kind: 'ai_generated_fictional_character' }];
const clients: Client[] = [];
const servers: McpServer[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(servers.splice(0).map(server => server.close()));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function submit(extras: Record<string, unknown>) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubEnv('CONTROL_API_URL', 'https://gateway.example');
  vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(options.body)) });
    return new Response(JSON.stringify({ job_id: 'prepared-job', status: 'pending' }), {
      status: 202, headers: { 'Content-Type': 'application/json' },
    });
  });
  const server = new McpServer({ name: 'video-contract', version: '1.0.0' });
  registerManageAi(server);
  const client = new Client({ name: 'video-caller', version: '1.0.0' });
  clients.push(client); servers.push(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: 'manage_ai', arguments: {
    action: 'submit_video', app_id: 'test-app', model: 'example/video', prompt: 'A fictional character walking',
    duration: 4, input_images: ['https://images.example/character.png'], ...extras,
  } });
  return { sent, result };
}

describe('manage_ai declared video references', () => {
  it.each(['on_rejection', 'upfront'])('forwards explicit declarations and %s through the MCP schema to REST', async policy => {
    const { sent, result } = await submit({ reference_declarations: declarations, prepare_references: policy });
    expect(result.isError).not.toBe(true);
    expect(sent).toEqual([{ url: 'https://gateway.example/v1/test-app/videos/completions', body: {
      model: 'example/video', prompt: 'A fictional character walking', duration: 4,
      input_images: ['https://images.example/character.png'],
      reference_declarations: declarations, prepare_references: policy,
    } }]);
  });

  it('keeps undeclared video requests on their existing REST contract', async () => {
    const { sent } = await submit({});
    expect(sent[0].body).toEqual({ model: 'example/video', prompt: 'A fictional character walking', duration: 4,
      input_images: ['https://images.example/character.png'] });
  });

  it.each([
    { reference_declarations: [{ path: '/input_images/0', kind: 'real_person' }] },
    { prepare_references: 'always_retry' },
  ])('rejects invalid declaration vocabulary before sending a REST request: %j', async extras => {
    const { sent, result } = await submit(extras);
    expect(result.isError).toBe(true);
    expect(sent).toEqual([]);
  });
});
