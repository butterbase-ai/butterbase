import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getBaseUrl, getHeaders } from '../api-client.js';

export function registerSelectRows(server: McpServer) {
  server.tool(
    'select_rows',
    `Query rows from a table using the auto-generated REST API.

By default, this tool authenticates with the platform API key (butterbase_service role),
which bypasses Row-Level Security and returns ALL rows regardless of RLS policies.

To test RLS enforcement from this tool, use the as_role and as_user parameters:
  - as_role: "anon" — simulate an anonymous request (butterbase_anon role)
  - as_role: "user", as_user: "<user-uuid>" — simulate a specific end-user (butterbase_user role)

Without as_role, this tool always runs as butterbase_service (full access).

Use this to:
  - Fetch data from tables (as admin/service — sees all rows)
  - Filter, sort, and paginate results
  - Select specific columns

Example — Basic query:
  Input: {
    app_id: "app_abc123",
    table: "posts",
    limit: 10
  }
  Output: [
    { id: "uuid-1", title: "Hello World", created_at: "2024-01-15T10:00:00Z" },
    ...
  ]

Example — With filters:
  Input: {
    app_id: "app_abc123",
    table: "posts",
    filters: {
      "status": "eq.published",
      "created_at": "gt.2024-01-01"
    },
    order: "created_at.desc",
    limit: 20
  }

Filter operators:
  - eq (equals): status=eq.published
  - neq (not equals): status=neq.draft
  - gt (greater than): age=gt.18
  - gte (greater than or equal): age=gte.18
  - lt (less than): price=lt.100
  - lte (less than or equal): price=lte.100
  - like (pattern match): title=like.%hello%
  - ilike (case-insensitive): title=ilike.%hello%
  - is (null/true/false): deleted_at=is.null
  - in (list): id=in.(1,2,3)
  - fts (full-text search): title=fts.hello world

Common errors:
  - VALIDATION_TABLE_NOT_FOUND: Table doesn't exist, use manage_schema (action: "get") to verify
  - VALIDATION_INVALID_SCHEMA: Invalid filter format

Idempotency: Safe to call multiple times (read-only operation).`,
    {
      app_id: z.string().describe('The app ID'),
      table: z.string().describe('The table name'),
      filters: z.record(z.string()).optional().describe('Filter conditions (column: "operator.value")'),
      select: z.string().optional().describe('Comma-separated column names to return'),
      order: z.string().optional().describe('Sort order (e.g., "created_at.desc")'),
      limit: z.number().int().positive().optional().describe('Maximum number of rows to return'),
      offset: z.number().int().min(0).optional().describe('Number of rows to skip'),
      as_role: z.enum(['anon', 'user']).optional().describe('Simulate a specific role for RLS testing. "anon" for anonymous, "user" for authenticated end-user (requires as_user).'),
      as_user: z.string().optional().describe('User ID (UUID) to simulate when as_role is "user". Required when as_role is "user".'),
    },
    {
      title: 'Select Rows',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const { app_id, table, filters, select, order, limit, offset, as_role, as_user } = args;

      if (as_role === 'user' && !as_user) {
        return {
          content: [{ type: 'text' as const, text: 'Error: as_user (user ID) is required when as_role is "user"' }],
          isError: true,
        };
      }

      // Build query string
      const params = new URLSearchParams();
      if (filters) {
        for (const [key, value] of Object.entries(filters)) {
          params.append(key, value);
        }
      }
      if (select) params.append('select', select);
      if (order) params.append('order', order);
      if (limit) params.append('limit', limit.toString());
      if (offset) params.append('offset', offset.toString());

      const queryString = params.toString();
      const url = `${getBaseUrl()}/v1/${app_id}/${table}${queryString ? '?' + queryString : ''}`;

      const headers: Record<string, string> = { ...getHeaders() as Record<string, string> };
      if (as_role) headers['X-Butterbase-As-Role'] = as_role;
      if (as_user) headers['X-Butterbase-As-User'] = as_user;

      const res = await fetch(url, {
        method: 'GET',
        headers,
      });

      const data = await res.json();

      if (!res.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(data, null, 2),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );
}
