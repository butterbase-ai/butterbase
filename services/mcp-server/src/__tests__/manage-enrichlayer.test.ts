// Unit tests for manage_enrichlayer MCP tool.
// Verifies that search_person / search_company send camelCase structured body
// fields (not the old { query: ... } shape).

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

describe('manage_enrichlayer tool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Fix 1: MCP body shape — search_person sends camelCase structured fields ──
  it('search_person sends camelCase body fields (NOT a query string)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { results: [] }, usage: { creditsConsumed: 0 } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    await client.callTool({
      name: 'manage_enrichlayer',
      arguments: {
        app_id: 'app_test123',
        action: 'search_person',
        current_role_title: 'CTO',
        current_company_name: 'Acme',
        country: 'US',
        page_size: 10,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/app_test123\/enrichlayer\/search\/person$/);
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body as string);
    // camelCase fields must be present
    expect(body.currentRoleTitle).toBe('CTO');
    expect(body.currentCompanyName).toBe('Acme');
    expect(body.country).toBe('US');
    expect(body.pageSize).toBe(10);
    // old query field must NOT be present
    expect(body).not.toHaveProperty('query');
  });

  // ── Fix 1: MCP body shape — search_company sends camelCase structured fields ─
  it('search_company sends camelCase body fields (NOT a query string)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { results: [] }, usage: { creditsConsumed: 0 } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    await client.callTool({
      name: 'manage_enrichlayer',
      arguments: {
        app_id: 'app_test123',
        action: 'search_company',
        industry: 'tech',
        country: 'US',
        employee_count_max: 500,
        enrich_profiles: true,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/app_test123\/enrichlayer\/search\/company$/);
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body as string);
    // camelCase fields must be present
    expect(body.industry).toBe('tech');
    expect(body.country).toBe('US');
    expect(body.employeeCountMax).toBe(500);
    expect(body.enrichProfiles).toBe(true);
    // old query field must NOT be present
    expect(body).not.toHaveProperty('query');
  });

  // ── Fix 5: description fix — linkedin_profile_url no longer mentions get_email_lookup ──
  it('linkedin_profile_url description does not mention get_email_lookup', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'manage_enrichlayer');
    expect(tool).toBeDefined();

    const urlProp = (tool!.inputSchema as any)?.properties?.linkedin_profile_url;
    expect(urlProp?.description).not.toContain('get_email_lookup');
    expect(urlProp?.description).toContain('get_profile');
    expect(urlProp?.description).toContain('queue_email_lookup');
  });
});
