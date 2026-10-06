/**
 * Reads the org's substrate `yolo_mode` for one operator turn.
 *
 * WHY THIS IS AN MCP READ AND NOT A DB READ. `yolo_mode` lives in
 * `substrate.organizations`, in the substrate database. control-api has no pool
 * for it — substrate is reached over HTTP, through the same MCP surface the
 * operator itself uses. `manage_substrate action="get_settings"` is already an
 * 'allow'-tier action (OPERATOR_ALLOWED_SUBSTRATE_ACTIONS), and the operator's
 * own credential is org-bound, so the read is scoped to its own org by
 * construction: there is no org argument to get wrong.
 *
 * WHY IT FAILS TO `false`. Every failure mode here — substrate not provisioned,
 * MCP unreachable, a shape we do not recognise — resolves to `false`, which
 * means "gate normally". The dangerous direction is a transient error being
 * read as "the owner pre-authorised everything", so the only input that opens
 * the gate is an explicit boolean `true` in the response. A string "true", a 1,
 * or a missing field do not.
 *
 * WHY IT IS READ ONCE PER TURN, not per tool call. A turn is short and the flag
 * is changed by hand; re-reading per call would multiply MCP round-trips for no
 * behavioural gain. The window this leaves is bounded by one turn: flipping
 * yolo OFF mid-turn does not retroactively gate calls already in flight. That
 * is acceptable because turning it off is a de-escalation a human is present
 * for, and the next wake picks it up.
 */

type McpLike = { call(name: string, args: unknown, jwt: string): Promise<unknown> };

/**
 * Pull `yolo_mode` out of whatever `get_settings` came back as.
 *
 * The MCP layer wraps results more than once (`{ok, result}` from
 * `callMcpTool`, `{content:[{type:'text',text}]}` from the MCP tool itself,
 * and the route's own `{yolo_mode}` body inside that), and the exact nesting
 * has changed before. Rather than pin one shape, walk the value and accept the
 * first `yolo_mode` that is a literal boolean — any other type is ignored
 * rather than coerced.
 */
export function extractYoloMode(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;

  if (typeof value === 'string') {
    // MCP text content: the payload is a JSON document in a string.
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    try {
      return extractYoloMode(JSON.parse(trimmed), depth + 1);
    } catch {
      return false;
    }
  }

  if (Array.isArray(value)) {
    return value.some((v) => extractYoloMode(v, depth + 1));
  }

  if (typeof value !== 'object') return false;

  const obj = value as Record<string, unknown>;
  // Only a literal `true` opens the gate. Deliberately not truthiness.
  if (obj.yolo_mode === true) return true;
  if (typeof obj.yolo_mode === 'boolean') return obj.yolo_mode;

  return Object.values(obj).some((v) => extractYoloMode(v, depth + 1));
}

/**
 * Read the operator org's `yolo_mode`. Never throws — see the module comment.
 */
export async function readOperatorYoloMode(mcp: McpLike, jwt: string): Promise<boolean> {
  try {
    const res = await mcp.call('manage_substrate', { action: 'get_settings' }, jwt);
    return extractYoloMode(res);
  } catch {
    return false;
  }
}
