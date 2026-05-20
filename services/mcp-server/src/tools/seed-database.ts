import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getBaseUrl, getHeaders } from '../api-client.js';

export function registerSeedDatabase(server: McpServer) {
  server.tool(
    'seed_database',
    `Insert multiple rows into a table in a single call. Useful for seeding sample data,
bootstrapping test fixtures, or populating lookup tables.

IMPORTANT: This tool authenticates with the platform API key (butterbase_service role),
which bypasses Row-Level Security. Inserts via this tool are not subject to RLS policies.

Rows are inserted sequentially. If a row fails (e.g., duplicate key, constraint violation),
the tool skips it and continues with the remaining rows. The response reports how many
rows were inserted vs failed, with error details for each failure.

Example:
  Input: {
    app_id: "app_abc123",
    table: "products",
    rows: [
      { "name": "Widget", "price": 999, "category": "tools" },
      { "name": "Gadget", "price": 1499, "category": "electronics" },
      { "name": "Doohickey", "price": 299, "category": "tools" }
    ]
  }
  Output: {
    inserted: 3,
    failed: 0,
    errors: [],
    rows: [ { id: "uuid-1", ... }, { id: "uuid-2", ... }, { id: "uuid-3", ... } ]
  }

Notes:
  - Columns with defaults (like id, created_at) can be omitted
  - Each row is an independent insert — failures don't roll back other rows
  - Maximum 100 rows per call

Common errors (per row):
  - VALIDATION_UNIQUE_CONSTRAINT_VIOLATION: Duplicate value in unique column
  - VALIDATION_FOREIGN_KEY_VIOLATION: Referenced record doesn't exist
  - VALIDATION_NOT_NULL_VIOLATION: Required field is missing

Idempotency: Not idempotent — creates new rows each time.`,
    {
      app_id: z.string().describe('The app ID'),
      table: z.string().describe('The table name'),
      rows: z.array(z.record(z.any())).min(1).max(100).describe('Array of row objects to insert (max 100)'),
    },
    {
      title: 'Seed Database',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const { app_id, table, rows } = args;
      const url = `${getBaseUrl()}/v1/${app_id}/${table}`;
      const headers = getHeaders();

      const inserted: unknown[] = [];
      const errors: { row_index: number; error: unknown }[] = [];

      for (let i = 0; i < rows.length; i++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(rows[i]),
          });

          const data = await res.json();

          if (!res.ok) {
            errors.push({ row_index: i, error: data });
          } else {
            inserted.push(data);
          }
        } catch (err) {
          errors.push({
            row_index: i,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }

      const summary = {
        inserted: inserted.length,
        failed: errors.length,
        errors,
        rows: inserted,
      };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(summary, null, 2),
        }],
        isError: errors.length > 0 && inserted.length === 0,
      };
    }
  );
}
