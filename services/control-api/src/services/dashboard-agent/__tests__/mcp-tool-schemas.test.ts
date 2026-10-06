/**
 * `mcp-tool-schemas.ts` — real argument schemas, fetched from the validator.
 *
 * The property under test is narrow but load-bearing: what the model is TOLD
 * about a tool's arguments must come from the same place that REJECTS them.
 * The hand-written catalog failed that in both directions — it omitted every
 * required field except `action`, and advertised `action` as required on tools
 * that reject it outright. The model obeyed the schema and was rejected for it,
 * six times in one turn on `select_rows` alone.
 *
 * So the tests here are mostly about the FAILURE paths, because a schema
 * fetcher that throws, or that caches an outage, is worse than the bug it
 * replaces: it would take turns down rather than merely making them clumsy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchMcpToolSchemas, applyMcpToolSchemas, __resetMcpToolSchemaCache } from '../mcp-tool-schemas.js';

const JWT = 'bb_sk_test';

const REAL_SELECT_ROWS = {
  type: 'object',
  properties: {
    app_id: { type: 'string' },
    table: { type: 'string' },
    limit: { type: 'number' },
  },
  required: ['app_id', 'table'],
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function sseResponse(body: unknown) {
  const text = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    text: async () => text,
    json: async () => {
      throw new Error('should not call json() on an SSE response');
    },
  } as unknown as Response;
}

const okPayload = {
  result: { tools: [{ name: 'select_rows', inputSchema: REAL_SELECT_ROWS }] },
};

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  __resetMcpToolSchemaCache();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetMcpToolSchemaCache();
});

describe('fetching', () => {
  it('returns the schema the server validates against', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(okPayload)) as any;
    const schemas = await fetchMcpToolSchemas(JWT);
    expect(schemas.get('select_rows')).toEqual(REAL_SELECT_ROWS);
  });

  it('asks for tools/list with both accept types', async () => {
    const spy = vi.fn(async () => jsonResponse(okPayload));
    globalThis.fetch = spy as any;
    await fetchMcpToolSchemas(JWT);
    const init = spy.mock.calls[0][1] as any;
    expect(JSON.parse(init.body).method).toBe('tools/list');
    // StreamableHTTP answers 406 without both — the same trap callMcpTool hit.
    expect(init.headers.accept).toContain('text/event-stream');
    expect(init.headers.accept).toContain('application/json');
    expect(init.headers.authorization).toBe(`Bearer ${JWT}`);
  });

  it('parses an SSE reply, because the transport may answer either way', async () => {
    globalThis.fetch = vi.fn(async () => sseResponse(okPayload)) as any;
    const schemas = await fetchMcpToolSchemas(JWT);
    expect(schemas.get('select_rows')).toEqual(REAL_SELECT_ROWS);
  });
});

describe('failure is never fatal', () => {
  it.each([
    ['a network error', async () => { throw new Error('ECONNREFUSED'); }],
    ['a non-200', async () => jsonResponse({}, 503)],
    ['a JSON-RPC error', async () => jsonResponse({ error: { message: 'nope' } })],
    ['a malformed payload', async () => jsonResponse({ result: { tools: 'not-an-array' } })],
  ])('returns an empty map on %s, rather than throwing', async (_label, impl) => {
    globalThis.fetch = vi.fn(impl) as any;
    await expect(fetchMcpToolSchemas(JWT)).resolves.toBeInstanceOf(Map);
    expect((await fetchMcpToolSchemas(JWT)).size).toBe(0);
  });

  it('does not cache an empty result, so a blip is not pinned for the whole TTL', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('down'); }) as any;
    expect((await fetchMcpToolSchemas(JWT)).size).toBe(0);

    globalThis.fetch = vi.fn(async () => jsonResponse(okPayload)) as any;
    expect((await fetchMcpToolSchemas(JWT)).get('select_rows')).toEqual(REAL_SELECT_ROWS);
  });

  it('caches a good result instead of refetching every turn', async () => {
    const spy = vi.fn(async () => jsonResponse(okPayload));
    globalThis.fetch = spy as any;
    await fetchMcpToolSchemas(JWT);
    await fetchMcpToolSchemas(JWT);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('overlaying onto the catalog', () => {
  const HAND_WRITTEN = [
    // Exactly what the catalog advertised, and exactly what the server rejects.
    { name: 'select_rows', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: true } },
    { name: 'write_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  ];

  it('replaces the wrong hand-written schema with the real one', () => {
    const out = applyMcpToolSchemas(HAND_WRITTEN, new Map([['select_rows', REAL_SELECT_ROWS]]));
    expect(out.find((t) => t.name === 'select_rows')!.parameters).toEqual(REAL_SELECT_ROWS);
  });

  it('stops advertising `action` as required on a tool that rejects it', () => {
    const out = applyMcpToolSchemas(HAND_WRITTEN, new Map([['select_rows', REAL_SELECT_ROWS]]));
    const p = out.find((t) => t.name === 'select_rows')!.parameters as any;
    // The precise defect: the model was told to send `action`, then rejected
    // with "Unrecognized key(s) in object: action".
    expect(p.required).not.toContain('action');
    expect(p.required).toEqual(['app_id', 'table']);
    expect(p.properties).not.toHaveProperty('action');
  });

  it('leaves loop-internal tools alone — they have no MCP counterpart', () => {
    const out = applyMcpToolSchemas(HAND_WRITTEN, new Map([['select_rows', REAL_SELECT_ROWS]]));
    expect(out.find((t) => t.name === 'write_file')!.parameters).toEqual(HAND_WRITTEN[1].parameters);
  });

  it('changes nothing when no schemas were fetched', () => {
    expect(applyMcpToolSchemas(HAND_WRITTEN, new Map())).toEqual(HAND_WRITTEN);
  });
});
