import type { Pool } from 'pg';
import { getAppPoolForApp } from '../app-pool.js';
import { executeWithRole } from '../rls-context.js';
import { uploadObject, downloadObject } from '../s3.js';
import { randomUUID } from 'crypto';

export interface ToolCallContext {
  appId: string;
  runId: string;
  callerKind: 'end_user' | 'function' | 'dashboard';
  callerUserId: string | null;
}

export interface BuiltinResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

// Max content size for write_storage (1 MB base64 encoded ≈ 768 KB binary)
const MAX_WRITE_CONTENT_BYTES = 1 * 1024 * 1024;
// Max object size for read_storage (5 MB binary)
const MAX_READ_OBJECT_BYTES = 5 * 1024 * 1024;

/**
 * Validates that a string is a safe SQL identifier (lowercase letters, digits,
 * underscores; must start with a letter or underscore).
 */
function quoteIdent(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad ident: ${s}`);
  return `"${s}"`;
}

function pickRole(callerKind: ToolCallContext['callerKind']): 'butterbase_user' | 'butterbase_service' {
  return callerKind === 'end_user' ? 'butterbase_user' : 'butterbase_service';
}

// ---------------------------------------------------------------------------
// query_table
// ---------------------------------------------------------------------------
async function queryTable(
  args: Record<string, unknown>,
  ctx: ToolCallContext,
  controlPool: Pool,
): Promise<BuiltinResult> {
  const table = String(args.table ?? '');
  const filter = (args.filter as Record<string, unknown>) ?? {};
  const limit = Math.min(Number(args.limit ?? 50), 200);

  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    return { ok: false, error: 'invalid table name' };
  }

  const role = pickRole(ctx.callerKind);
  const userId = ctx.callerKind === 'end_user' ? ctx.callerUserId : null;
  const dataPool = await getAppPoolForApp(controlPool, ctx.appId, ctx.appId);

  try {
    const result = await executeWithRole(dataPool, role, userId, async (client) => {
      const cols = Object.keys(filter);
      const where = cols.length
        ? 'WHERE ' + cols.map((k, i) => `${quoteIdent(k)} = $${i + 1}`).join(' AND ')
        : '';
      const sql = `SELECT * FROM ${quoteIdent(table)} ${where} LIMIT ${limit}`;
      return client.query(sql, Object.values(filter));
    });
    return { ok: true, result: { rows: result.rows, row_count: result.rowCount } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// insert_row
// ---------------------------------------------------------------------------
async function insertRow(
  args: Record<string, unknown>,
  ctx: ToolCallContext,
  controlPool: Pool,
): Promise<BuiltinResult> {
  const table = String(args.table ?? '');
  const values = (args.values as Record<string, unknown>) ?? {};

  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    return { ok: false, error: 'invalid table name' };
  }

  const entries = Object.entries(values);
  if (entries.length === 0) {
    return { ok: false, error: 'values must be a non-empty object' };
  }

  // Validate column identifiers
  for (const [col] of entries) {
    if (!/^[a-z_][a-z0-9_]*$/.test(col)) {
      return { ok: false, error: `invalid column name: ${col}` };
    }
  }

  const role = pickRole(ctx.callerKind);
  const userId = ctx.callerKind === 'end_user' ? ctx.callerUserId : null;
  const dataPool = await getAppPoolForApp(controlPool, ctx.appId, ctx.appId);

  try {
    const result = await executeWithRole(dataPool, role, userId, async (client) => {
      const cols = entries.map(([k]) => quoteIdent(k)).join(', ');
      const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ');
      const vals = entries.map(([, v]) => v);
      const sql = `INSERT INTO ${quoteIdent(table)} (${cols}) VALUES (${placeholders}) RETURNING *`;
      return client.query(sql, vals);
    });
    return { ok: true, result: { row: result.rows[0] } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// update_row
// ---------------------------------------------------------------------------
async function updateRow(
  args: Record<string, unknown>,
  ctx: ToolCallContext,
  controlPool: Pool,
): Promise<BuiltinResult> {
  const table = String(args.table ?? '');
  const id = args.id;
  const patch = (args.patch as Record<string, unknown>) ?? {};

  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    return { ok: false, error: 'invalid table name' };
  }
  if (!id) {
    return { ok: false, error: 'id is required for update_row' };
  }

  const entries = Object.entries(patch);
  if (entries.length === 0) {
    return { ok: false, error: 'patch must be a non-empty object' };
  }

  for (const [col] of entries) {
    if (!/^[a-z_][a-z0-9_]*$/.test(col)) {
      return { ok: false, error: `invalid column name: ${col}` };
    }
  }

  const role = pickRole(ctx.callerKind);
  const userId = ctx.callerKind === 'end_user' ? ctx.callerUserId : null;
  const dataPool = await getAppPoolForApp(controlPool, ctx.appId, ctx.appId);

  try {
    const result = await executeWithRole(dataPool, role, userId, async (client) => {
      const setClauses = entries.map(([k], i) => `${quoteIdent(k)} = $${i + 1}`).join(', ');
      const vals = [...entries.map(([, v]) => v), id];
      const sql = `UPDATE ${quoteIdent(table)} SET ${setClauses} WHERE "id" = $${vals.length} RETURNING *`;
      return client.query(sql, vals);
    });

    if (result.rows.length === 0) {
      return { ok: false, error: 'row not found or access denied' };
    }
    return { ok: true, result: { row: result.rows[0] } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// delete_row
// ---------------------------------------------------------------------------
async function deleteRow(
  args: Record<string, unknown>,
  ctx: ToolCallContext,
  controlPool: Pool,
): Promise<BuiltinResult> {
  const table = String(args.table ?? '');
  const id = args.id;

  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    return { ok: false, error: 'invalid table name' };
  }
  if (!id) {
    return { ok: false, error: 'id is required for delete_row' };
  }

  const role = pickRole(ctx.callerKind);
  const userId = ctx.callerKind === 'end_user' ? ctx.callerUserId : null;
  const dataPool = await getAppPoolForApp(controlPool, ctx.appId, ctx.appId);

  try {
    const result = await executeWithRole(dataPool, role, userId, async (client) => {
      const sql = `DELETE FROM ${quoteIdent(table)} WHERE "id" = $1 RETURNING id`;
      return client.query(sql, [id]);
    });

    if (result.rowCount === 0) {
      return { ok: false, error: 'row not found or access denied' };
    }
    return { ok: true, result: { deleted: true, id: result.rows[0]?.id } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// read_storage
// ---------------------------------------------------------------------------
async function readStorage(
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<BuiltinResult> {
  const rawKey = String(args.key ?? '');
  if (!rawKey) {
    return { ok: false, error: 'key is required for read_storage' };
  }
  // Reject path traversal and absolute paths; agent can only address keys
  // under its own appId namespace.
  const trimmed = rawKey.replace(/^\/+/, '');
  if (trimmed.split('/').some((seg) => seg === '..' || seg === '.')) {
    return { ok: false, error: 'invalid key' };
  }
  // If the agent passed an already-namespaced key (appId/...), strip the
  // prefix to avoid double-prefixing — but only if the prefix matches its
  // own appId. Any other prefix is treated as a relative key.
  const stripped = trimmed.startsWith(`${ctx.appId}/`)
    ? trimmed.slice(ctx.appId.length + 1)
    : trimmed;
  const storageKey = `${ctx.appId}/${stripped}`;

  try {
    const buf = await downloadObject(storageKey);
    if (buf.length > MAX_READ_OBJECT_BYTES) {
      return { ok: false, error: `object exceeds maximum size of ${MAX_READ_OBJECT_BYTES} bytes` };
    }
    const content_base64 = buf.toString('base64');
    return { ok: true, result: { key: storageKey, content_base64, size_bytes: buf.length } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// write_storage
// ---------------------------------------------------------------------------
async function writeStorage(
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<BuiltinResult> {
  const key = String(args.key ?? '');
  const content_base64 = String(args.content_base64 ?? '');
  const content_type = String(args.content_type ?? 'application/octet-stream');

  if (!key) {
    return { ok: false, error: 'key is required for write_storage' };
  }
  if (!content_base64) {
    return { ok: false, error: 'content_base64 is required for write_storage' };
  }
  if (content_base64.length > MAX_WRITE_CONTENT_BYTES) {
    return { ok: false, error: `content_base64 exceeds maximum size of ${MAX_WRITE_CONTENT_BYTES} bytes` };
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(content_base64, 'base64');
  } catch {
    return { ok: false, error: 'content_base64 is not valid base64' };
  }

  // Build a namespaced key: appId/runId/<provided-key> to isolate per app
  const storageKey = `${ctx.appId}/${ctx.runId ?? randomUUID()}/${key}`;

  try {
    await uploadObject(storageKey, buf, content_type);
    return { ok: true, result: { key: storageKey, size_bytes: buf.length } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// auth_user_lookup
// ---------------------------------------------------------------------------
async function authUserLookup(
  args: Record<string, unknown>,
  ctx: ToolCallContext,
  controlPool: Pool,
): Promise<BuiltinResult> {
  const email = args.email ? String(args.email) : null;
  const id = args.id ? String(args.id) : null;

  if (!email && !id) {
    return { ok: false, error: 'auth_user_lookup requires either email or id' };
  }

  try {
    // App end-users are stored in the app-scoped data plane DB under the
    // `auth_users` table (populated by Butterbase's auth system).
    const dataPool = await getAppPoolForApp(controlPool, ctx.appId, ctx.appId);

    const result = await executeWithRole(dataPool, 'butterbase_service', null, async (client) => {
      if (id) {
        return client.query(
          `SELECT id, email, created_at FROM auth_users WHERE id = $1 LIMIT 1`,
          [id],
        );
      }
      return client.query(
        `SELECT id, email, created_at FROM auth_users WHERE email = $1 LIMIT 1`,
        [email],
      );
    });

    if (result.rows.length === 0) {
      return { ok: false, error: 'user not found' };
    }
    return { ok: true, result: result.rows[0] };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
export async function dispatchBuiltin(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
  controlPool: Pool,
): Promise<BuiltinResult> {
  switch (toolName) {
    case 'query_table':
      return queryTable(args, ctx, controlPool);
    case 'insert_row':
      return insertRow(args, ctx, controlPool);
    case 'update_row':
      return updateRow(args, ctx, controlPool);
    case 'delete_row':
      return deleteRow(args, ctx, controlPool);
    case 'read_storage':
      return readStorage(args, ctx);
    case 'write_storage':
      return writeStorage(args, ctx);
    case 'auth_user_lookup':
      return authUserLookup(args, ctx, controlPool);
    default:
      return { ok: false, error: `unknown builtin tool: ${toolName}` };
  }
}
