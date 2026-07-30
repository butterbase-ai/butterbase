/**
 * Live schema injection for the dashboard-agent system prompt.
 *
 * Each turn, we look at the last N messages in the conversation, pull out
 * every app_id the agent has recently touched (from the `tool_args` JSONB
 * column), fetch each app's current schema via `manage_schema.get`, and
 * render a compact per-app summary that gets prepended to the system prompt.
 *
 * This keeps the model honest about actual column names/types instead of
 * hallucinating a schema from earlier in the conversation.
 */

import pg from 'pg';
import { getRecentToolArgs } from './store.js';

type Mcp = { call(name: string, args: unknown, jwt: string): Promise<any> };

// ---------------------------------------------------------------------------
// Schema shapes (mirrors control-api's IntrospectedSchema, kept loose here
// since we only read a few fields from the manage_schema.get payload).
// ---------------------------------------------------------------------------

interface ColumnInfo {
  type: string;
  primaryKey?: boolean;
  nullable?: boolean;
  default?: string;
  unique?: boolean;
  references?: unknown;
}

interface TableInfo {
  columns: Record<string, ColumnInfo>;
}

interface SchemaPayload {
  tables?: Record<string, TableInfo>;
}

// ---------------------------------------------------------------------------
// getRecentAppIds
// ---------------------------------------------------------------------------

const DEFAULT_RECENT_MESSAGE_LIMIT = 20;

/**
 * Walk a value for any string found at key "app_id", recursively. `tool_args`
 * is usually a flat object (e.g. `{ app_id, path, content }`), but we walk
 * nested objects/arrays too in case a tool ever nests its app_id.
 */
function collectAppIds(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectAppIds(item, out);
    return;
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'app_id' && typeof val === 'string' && val.length > 0) {
      out.add(val);
      continue;
    }
    if (val && typeof val === 'object') collectAppIds(val, out);
  }
}

/**
 * Fetch the last N messages for a conversation and extract the set of
 * unique app_id values referenced in tool_args (the JSONB column populated
 * on both the assistant's tool-call row and the resulting tool-result row —
 * see store.ts#appendMessage). Deduped, in first-seen order (most recent
 * message first, since we scan DESC).
 */
export async function getRecentAppIds(
  pool: pg.Pool,
  conversationId: string,
  limit: number = DEFAULT_RECENT_MESSAGE_LIMIT,
): Promise<string[]> {
  const toolArgsRows = await getRecentToolArgs(pool, conversationId, limit);

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const toolArgs of toolArgsRows) {
    const before = seen.size;
    collectAppIds(toolArgs, seen);
    if (seen.size > before) {
      for (const id of seen) {
        if (!ordered.includes(id)) ordered.push(id);
      }
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// fetchAppSchemas
// ---------------------------------------------------------------------------

/**
 * Render a column as `name type [pk|NOT NULL]`.
 */
function formatColumn(name: string, col: ColumnInfo): string {
  const parts = [name, col.type];
  if (col.primaryKey) {
    parts.push('pk');
  } else if (col.nullable === false) {
    parts.push('NOT NULL');
  }
  return parts.join(' ');
}

/**
 * Compact form for a single table: `tablename(col1 type [pk|NOT NULL], ...)`.
 */
function formatTable(tableName: string, table: TableInfo): string {
  const cols = Object.entries(table.columns ?? {}).map(([colName, col]) => formatColumn(colName, col));
  return `${tableName}(${cols.join(', ')})`;
}

/**
 * Compact form for a whole app's schema: one line per table, newline-joined.
 */
export function formatCompactSchema(schema: SchemaPayload): string {
  const tables = schema.tables ?? {};
  return Object.entries(tables)
    .map(([tableName, table]) => formatTable(tableName, table))
    .join('\n');
}

/**
 * Fetch and compact-format the schema for each given app_id via
 * `manage_schema.get`. Failures for an individual app are logged and
 * skipped — a schema-fetch problem must never block the turn.
 *
 * Callers should maintain their own per-request cache (a plain Map keyed by
 * app_id) across calls within a single turn; this function does not cache
 * internally since it may be called with a fresh app_id list each time.
 */
export async function fetchAppSchemas(
  appIds: string[],
  jwt: string,
  mcp: Mcp,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  await Promise.all(
    appIds.map(async (appId) => {
      try {
        const result = await mcp.call('manage_schema', { action: 'get', app_id: appId }, jwt);
        const schema: SchemaPayload | undefined = result?.schema ?? result;
        const compact = formatCompactSchema(schema ?? {});
        if (compact) out[appId] = compact;
      } catch (err) {
        console.warn(
          `[dashboard-agent/schema-context] manage_schema.get failed for app_id=${appId}, skipping:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );

  return out;
}

// ---------------------------------------------------------------------------
// buildSchemaPromptBlock
// ---------------------------------------------------------------------------

/**
 * Assemble the `# Current app schemas` prompt block from a map of
 * app_id -> compact schema string. Returns '' if there is nothing to show,
 * so callers can skip prepending entirely.
 */
export function buildSchemaPromptBlock(schemasByAppId: Record<string, string>): string {
  const entries = Object.entries(schemasByAppId);
  if (entries.length === 0) return '';

  const lines = entries.map(([appId, compact]) => `${appId}: ${compact}`);
  return `# Current app schemas\n\n${lines.join('\n')}\n\n`;
}

// ---------------------------------------------------------------------------
// Per-request cache helper
// ---------------------------------------------------------------------------

/**
 * Fetch schemas for appIds not already present in `cache`, populate the
 * cache, and return the full map (cached + newly fetched) restricted to
 * the requested appIds. Intended to be called once per turn with a
 * fresh `new Map()` (or a Map reused only within a single turn — never
 * globally, since schemas can change between turns).
 */
export async function fetchAppSchemasCached(
  appIds: string[],
  jwt: string,
  mcp: Mcp,
  cache: Map<string, string>,
): Promise<Record<string, string>> {
  const missing = appIds.filter((id) => !cache.has(id));
  if (missing.length > 0) {
    const fetched = await fetchAppSchemas(missing, jwt, mcp);
    for (const [appId, compact] of Object.entries(fetched)) {
      cache.set(appId, compact);
    }
  }

  const out: Record<string, string> = {};
  for (const appId of appIds) {
    const compact = cache.get(appId);
    if (compact) out[appId] = compact;
  }
  return out;
}
