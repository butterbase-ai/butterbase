import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getBaseUrl, getHeaders } from '../api-client.js';

export function registerInsertRow(server: McpServer) {
  server.tool(
    'insert_row',
    `Insert a new row into a table using the auto-generated REST API.

By default, this tool authenticates with the platform API key (butterbase_service role),
which bypasses Row-Level Security. Inserts via this tool are not subject to RLS policies.

To test RLS enforcement on writes, use the as_role and as_user parameters:
  - as_role: "anon" — simulate an anonymous insert (butterbase_anon role)
  - as_role: "user", as_user: "<user-uuid>" — simulate a specific end-user (butterbase_user role)

Without as_role, this tool always runs as butterbase_service (full access, bypasses RLS).

Use this to:
  - Add new records to tables (as admin/service — bypasses RLS)
  - Bootstrap initial data
  - Create test data

Example:
  Input: {
    app_id: "app_abc123",
    table: "posts",
    data: {
      "title": "Hello World",
      "body": "This is my first post",
      "status": "draft"
    }
  }
  Output: {
    id: "uuid-1234",
    title: "Hello World",
    body: "This is my first post",
    status: "draft",
    created_at: "2024-01-15T10:00:00Z"
  }

Notes:
  - Only provide columns that exist in the table schema
  - Columns with defaults (like id, created_at) can be omitted
  - The response includes the full inserted row with generated values

Common errors:
  - VALIDATION_TABLE_NOT_FOUND: Table doesn't exist, use manage_schema (action: "get") to verify
  - VALIDATION_UNIQUE_CONSTRAINT_VIOLATION: Duplicate value in unique column
  - VALIDATION_FOREIGN_KEY_VIOLATION: Referenced record doesn't exist
  - VALIDATION_NOT_NULL_VIOLATION: Required field is missing

Idempotency: Not idempotent - creates a new row each time.`,
    {
      app_id: z.string().describe('The app ID'),
      table: z.string().describe('The table name'),
      data: z.record(z.any()).describe('Column values to insert'),
      as_role: z.enum(['anon', 'user']).optional().describe('Simulate a specific role for RLS testing. "anon" for anonymous, "user" for authenticated end-user (requires as_user).'),
      as_user: z.string().optional().describe('User ID (UUID) to simulate when as_role is "user". Required when as_role is "user".'),
    },
    {
      title: 'Insert Row',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const { app_id, table, data, as_role, as_user } = args;

      if (as_role === 'user' && !as_user) {
        return {
          content: [{ type: 'text' as const, text: 'Error: as_user (user ID) is required when as_role is "user"' }],
          isError: true,
        };
      }

      const url = `${getBaseUrl()}/v1/${app_id}/${table}`;

      const headers: Record<string, string> = { ...getHeaders() as Record<string, string> };
      if (as_role) headers['X-Butterbase-As-Role'] = as_role;
      if (as_user) headers['X-Butterbase-As-User'] = as_user;

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
      });

      const responseData = await res.json();

      if (!res.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(responseData, null, 2),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(responseData, null, 2),
          },
        ],
      };
    }
  );
}
