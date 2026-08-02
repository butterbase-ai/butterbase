/**
 * MCP client wrapper for the dashboard assistant.
 * Calls the MCP server's HTTP endpoint with proper auth context.
 */

import { getToolCatalog } from './tool-catalog.js';

export { getToolCatalog };
export type { ToolSpec } from './tool-catalog.js';

export type McpCallResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

/**
 * Some models (notably Claude Haiku 4.5 over OpenRouter) stringify nested
 * object args when they emit tool_calls — passing `schema: "{...}"` instead
 * of `schema: { ... }`. The MCP server then rejects with:
 *   `Expected object, received string`.
 *
 * Recover by best-effort JSON-parsing any string value at the top level of
 * args whose payload looks like a JSON object or array. Leaves scalars,
 * plain string values, and already-parsed nested objects untouched.
 */
function normalizeToolArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    try {
      out[key] = JSON.parse(trimmed);
    } catch {
      // Not JSON — leave as-is.
    }
  }
  return out;
}

/**
 * Call an MCP tool via the HTTP endpoint.
 * @param name - The MCP tool name (e.g., 'manage_app')
 * @param args - Tool arguments as an object
 * @param jwt - Cognito Bearer JWT token
 * @param orgId - Optional active org; forwarded as `x-organization-id` so the
 *   MCP server carries the caller's org context into downstream API calls.
 * @returns Result object with ok flag, result, or error
 */
export async function callMcpTool(
  name: string,
  args: unknown,
  jwt: string,
  orgId?: string | null,
): Promise<McpCallResult> {
  const url = `${process.env.MCP_SERVER_URL ?? 'http://localhost:3010'}/mcp`;
  const normalizedArgs = normalizeToolArgs(args);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // MCP StreamableHTTP transport requires BOTH content types in Accept
        // (rejects with 406 Not Acceptable otherwise).
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${jwt}`,
        ...(orgId ? { 'x-organization-id': orgId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: normalizedArgs },
      }),
    });

    if (!res.ok) {
      return { ok: false, error: `mcp ${res.status}` };
    }

    // MCP StreamableHTTP transport MAY respond with SSE (`text/event-stream`)
    // instead of `application/json`, even for single-response `tools/call`.
    // Parse both.
    const contentType = res.headers.get('content-type') ?? '';
    let body: { result?: unknown; error?: { message?: string } };
    if (contentType.startsWith('text/event-stream')) {
      const text = await res.text();
      // SSE frames are `event:...\ndata: <json>\n\n`. Concatenate multi-line
      // data lines per frame (per SSE spec), then JSON.parse. We only care
      // about the frame carrying the JSON-RPC response for our id.
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
        } catch { /* skip non-JSON frames like heartbeats */ }
      }
      if (!jsonRpc) return { ok: false, error: 'mcp: no JSON-RPC response frame found' };
      body = jsonRpc;
    } else {
      body = await res.json() as { result?: unknown; error?: { message?: string } };
    }

    if (body.error) {
      return { ok: false, error: String(body.error.message ?? body.error) };
    }

    return { ok: true, result: body.result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
