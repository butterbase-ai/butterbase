/**
 * The REAL argument schemas for MCP tools, fetched from the MCP server.
 *
 * THE BUG THIS EXISTS TO FIX
 * --------------------------
 * `tool-catalog.ts` hand-writes the `parameters` it advertises to the model,
 * and for most tools that is `flatActionParams()`:
 *
 *     { properties: { action: {type:'string'} }, required: ['action'],
 *       additionalProperties: true }
 *
 * Which is not merely thin — it is WRONG in both directions at once.
 *
 * It UNDER-SPECIFIES: `app_id`, `table`, `function_name`, `code` and every
 * enum value appear nowhere in the schema, only as English in the description.
 * The model has to infer them, and when it infers wrong the MCP server rejects
 * the call.
 *
 * It also MIS-SPECIFIES: `required: ['action']` is advertised on tools that do
 * not accept an `action` argument at all. `select_rows` is the clearest case —
 * the schema says `action` is mandatory, the server answers
 * `Unrecognized key(s) in object: action`. The model obeys the schema it was
 * given and is punished for it, every single time.
 *
 * Measured on one operator turn (2026-08-10): six `select_rows` rejections for
 * the unrecognised `action`, plus missing-field rejections on
 * `invoke_function` (`function_name`), `deploy_function` (`code`) and
 * `read_file` (`app_id`), plus invalid-enum rejections on `manage_substrate`
 * and `manage_integrations`. Every one traced to this single helper.
 *
 * WHY FETCH RATHER THAN HAND-CORRECT
 * ----------------------------------
 * The MCP server already declares these as zod and validates against them, so
 * it is the only source that cannot disagree with the validator. Hand-writing
 * better schemas here would fix today's mismatches and start drifting the next
 * time a tool gains a parameter — which is exactly how the current ones got
 * wrong. `tools/list` returns the same JSON Schema the server enforces.
 *
 * FAILURE IS NON-FATAL BY DESIGN: every failure path returns an empty map and
 * the caller keeps the hand-written catalog. A momentarily unreachable MCP
 * server must degrade the model's argument accuracy, never break the turn.
 */

type JsonSchema = Record<string, unknown>;

type CacheEntry = { at: number; schemas: Map<string, JsonSchema> };

/**
 * Process-local, with a TTL rather than forever. Tool schemas change only on
 * an MCP server deploy, so a stale entry is harmless for minutes and a refetch
 * every turn would add a round-trip to a hot path for no benefit.
 */
let cache: CacheEntry | null = null;
const TTL_MS = 10 * 60 * 1000;

/** Exposed for tests; production has no reason to call this. */
export function __resetMcpToolSchemaCache(): void {
  cache = null;
}

/**
 * Parses both transports the MCP StreamableHTTP endpoint may answer with.
 * Mirrors `callMcpTool`'s handling — the server MAY reply with SSE even for a
 * single request, and a JSON-only reader silently fails against it.
 */
async function readRpcBody(res: Response): Promise<{ result?: unknown; error?: { message?: string } } | null> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.startsWith('text/event-stream')) {
    return (await res.json()) as { result?: unknown; error?: { message?: string } };
  }
  const text = await res.text();
  let jsonRpc: { result?: unknown; error?: { message?: string } } | null = null;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    try {
      const parsed = JSON.parse(dataLines.join('\n'));
      if (parsed && typeof parsed === 'object' && ('result' in parsed || 'error' in parsed)) {
        jsonRpc = parsed;
      }
    } catch {
      /* heartbeats and other non-JSON frames */
    }
  }
  return jsonRpc;
}

/**
 * `name -> inputSchema` for every tool the MCP server advertises.
 *
 * Returns an EMPTY MAP on any failure — unreachable server, non-200, JSON-RPC
 * error, malformed payload. Callers treat "no schema for this tool" as "keep
 * the hand-written one", so an empty map is simply today's behaviour.
 */
export async function fetchMcpToolSchemas(jwt: string, now = Date.now()): Promise<Map<string, JsonSchema>> {
  if (cache && now - cache.at < TTL_MS) return cache.schemas;

  const url = `${process.env.MCP_SERVER_URL ?? 'http://localhost:3010'}/mcp`;
  const schemas = new Map<string, JsonSchema>();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Both content types, or StreamableHTTP answers 406.
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    if (!res.ok) return schemas;

    const body = await readRpcBody(res);
    if (!body || body.error) return schemas;

    const tools = (body.result as { tools?: unknown[] } | undefined)?.tools;
    if (!Array.isArray(tools)) return schemas;

    for (const t of tools) {
      const tool = t as { name?: unknown; inputSchema?: unknown };
      if (typeof tool.name !== 'string') continue;
      // An input schema that is not an object is not usable as a function
      // schema; skipping leaves the hand-written entry in place rather than
      // advertising something the model cannot read.
      if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) continue;
      schemas.set(tool.name, tool.inputSchema as JsonSchema);
    }
  } catch {
    return new Map();
  }

  // Only cache a non-empty result. Caching an empty map would pin a transient
  // outage in place for the whole TTL, turning a blip into ten minutes of
  // degraded argument accuracy.
  if (schemas.size > 0) cache = { at: now, schemas };
  return schemas;
}

/**
 * Overlay real schemas onto the hand-written catalog.
 *
 * Server-supplied schemas WIN where present, because the server is what
 * validates. Tools with no server entry — the loop-internal ones like
 * `write_file`, `deploy_frontend` and `update_operator_scratchpad`, which have
 * no MCP counterpart — keep their hand-written schema, which for those is the
 * only source there is.
 */
export function applyMcpToolSchemas<T extends { name: string; parameters: object }>(
  tools: T[],
  schemas: Map<string, JsonSchema>,
): T[] {
  if (schemas.size === 0) return tools;
  return tools.map((t) => {
    const real = schemas.get(t.name);
    return real ? { ...t, parameters: real } : t;
  });
}
