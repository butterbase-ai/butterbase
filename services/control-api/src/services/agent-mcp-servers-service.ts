import type { Pool } from 'pg';
import { encrypt, decrypt } from './crypto.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

function getEncryptionKey(): string | undefined {
  return process.env.AUTH_ENCRYPTION_KEY;
}

function maskAuth(value: string | null): string | null {
  if (!value) return null;
  const key = getEncryptionKey();
  if (!key || !value.includes(':')) return '***';
  try {
    const plain = decrypt(value, key);
    return '***' + plain.slice(-4);
  } catch {
    return '***error';
  }
}

export interface McpServerRow {
  id: string;
  app_id: string;
  name: string;
  transport: string;
  url: string;
  auth_header: string | null;
  tool_acl: Record<string, unknown>;
  status: string;
  last_health: string | null;
  created_at: string;
}

export async function createMcpServer(
  db: Pool,
  appId: string,
  input: {
    name: string;
    transport: 'http' | 'sse' | 'streamable_http';
    url: string;
    auth_header?: string;
    tool_acl?: Record<string, unknown>;
  },
): Promise<McpServerRow> {
  let stored: string | null = null;
  if (input.auth_header) {
    const key = getEncryptionKey();
    if (!key) {
      throw new Error('AUTH_ENCRYPTION_KEY not set');
    }
    stored = encrypt(input.auth_header, key);
  }
  const result = await db.query(
    `INSERT INTO agent_mcp_servers
       (app_id, name, transport, url, auth_header, tool_acl)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, app_id, name, transport, url, auth_header, tool_acl,
               status, last_health, created_at`,
    [appId, input.name, input.transport, input.url, stored,
     JSON.stringify(input.tool_acl ?? {})],
  );
  const row = result.rows[0];
  return { ...row, auth_header: maskAuth(row.auth_header) };
}

export async function listMcpServers(db: Pool, appId: string): Promise<McpServerRow[]> {
  const result = await db.query(
    `SELECT id, app_id, name, transport, url, auth_header, tool_acl,
            status, last_health, created_at
     FROM agent_mcp_servers
     WHERE app_id = $1
     ORDER BY created_at DESC`,
    [appId],
  );
  return result.rows.map((r) => ({ ...r, auth_header: maskAuth(r.auth_header) }));
}

export async function deleteMcpServer(
  db: Pool, appId: string, id: string,
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM agent_mcp_servers WHERE app_id = $1 AND id = $2`,
    [appId, id],
  );
  return (result.rowCount ?? 0) > 0;
}

export type ProbeFn = (input: {
  url: string;
  transport: string;
  authHeader: string | null;
}) => Promise<
  | { ok: true; tools: { name: string; description: string }[] }
  | { ok: false; error: string }
>;

async function defaultProbe(input: {
  url: string;
  transport: string;
  authHeader: string | null;
}): Promise<{ ok: true; tools: { name: string; description: string }[] } | { ok: false; error: string }> {
  const headers: Record<string, string> = input.authHeader
    ? { Authorization: input.authHeader }
    : {};

  let transport;
  if (input.transport === 'sse') {
    transport = new SSEClientTransport(new URL(input.url), { requestInit: { headers } });
  } else {
    // 'http' | 'streamable_http'
    transport = new StreamableHTTPClientTransport(new URL(input.url), { requestInit: { headers } });
  }

  const client = new Client({ name: 'butterbase-control-api', version: '1' }, {});
  try {
    await client.connect(transport);
    try {
      const list = await client.listTools();
      return {
        ok: true,
        tools: list.tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
      };
    } finally {
      await client.close();
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function probeMcpServer(
  db: Pool,
  appId: string,
  id: string,
  probe: ProbeFn = defaultProbe,
): Promise<{ ok: true; tools: { name: string; description: string }[] } | { ok: false; error: string }> {
  const rowResult = await db.query(
    `SELECT id, transport, url, auth_header
     FROM agent_mcp_servers
     WHERE app_id = $1 AND id = $2`,
    [appId, id],
  );

  if (rowResult.rows.length === 0) {
    return { ok: false, error: 'MCP server not found' };
  }

  const row = rowResult.rows[0];
  let authHeader: string | null = null;
  if (row.auth_header) {
    const key = getEncryptionKey();
    if (!key) throw new Error('AUTH_ENCRYPTION_KEY not set');
    authHeader = decrypt(row.auth_header, key);
  }

  const result = await probe({ url: row.url, transport: row.transport, authHeader });

  if (result.ok) {
    await db.query(
      `UPDATE agent_mcp_servers
       SET last_health = now(), status = 'healthy'
       WHERE id = $1`,
      [id],
    );
  } else {
    await db.query(
      `UPDATE agent_mcp_servers
       SET status = 'unhealthy'
       WHERE id = $1`,
      [id],
    );
  }

  return result;
}
