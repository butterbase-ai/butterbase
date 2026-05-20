import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost } from '../api-client.js';

const ColumnDefInput = z.object({
  type: z.string().describe('Postgres column type (e.g. "uuid", "text", "integer", "boolean", "vector(1536)")'),
  primaryKey: z.boolean().optional().describe('Whether this is the primary key'),
  nullable: z.boolean().optional().describe('Whether NULL is allowed (default: true)'),
  default: z.string().optional().describe('SQL default expression (e.g. "gen_random_uuid()", "now()")'),
  unique: z.boolean().optional().describe('Add a UNIQUE constraint'),
  references: z.union([
    z.string().describe('Foreign key in "table.column" format (NO ACTION default)'),
    z.object({
      table: z.string().describe('Referenced table name'),
      column: z.string().describe('Referenced column name'),
      onDelete: z.enum(['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION'])
        .optional().describe('Action on parent row delete (default: NO ACTION)'),
      onUpdate: z.enum(['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION'])
        .optional().describe('Action on parent row update (default: NO ACTION)'),
    }).describe('Foreign key with referential action options'),
  ]).optional().describe('Foreign key — string "table.column" or object { table, column, onDelete?, onUpdate? }'),
});

const IndexDefInput = z.object({
  columns: z.array(z.string()).describe('Columns to index'),
  unique: z.boolean().optional().describe('Whether the index is unique'),
  method: z.string().optional().describe('Index method: btree, hash, gist, gin, hnsw, ivfflat'),
  opclass: z.string().optional().describe('Operator class (e.g. "vector_cosine_ops")'),
});

const TableDefInput = z.object({
  columns: z.record(z.string(), ColumnDefInput).describe('Column definitions'),
  indexes: z.record(z.string(), IndexDefInput).optional().describe('Index definitions'),
  _dropColumns: z.array(z.string()).optional().describe('Columns to drop (explicit opt-in for destructive ops)'),
});

const SchemaInput = z.object({
  tables: z.record(z.string(), TableDefInput).describe('Table definitions keyed by table name'),
  _drop: z.array(z.string()).optional().describe('Tables to drop (explicit opt-in for destructive ops)'),
});

export function registerManageSchema(server: McpServer) {
  server.tool(
    'manage_schema',
    `Manage the database schema: read current schema, apply changes, preview changes, and audit migration history.

Actions:
  - "get":             Get the current schema (tables, columns, indexes) and api_base
  - "apply":           Apply a declarative schema. Diffs against current and runs the safe DDL.
  - "dry_run":         Preview the SQL that "apply" would run, without executing
  - "list_migrations": List applied migrations (most recent first)

Parameters by action:
  get:             { app_id, action: "get" }
  apply:           { app_id, action: "apply",   schema, name? }
  dry_run:         { app_id, action: "dry_run", schema }
  list_migrations: { app_id, action: "list_migrations" }

Schema example:
  {
    tables: {
      posts: {
        columns: {
          id: { type: "uuid", primaryKey: true, default: "gen_random_uuid()" },
          title: { type: "text", nullable: false },
          author_id: { type: "uuid", references: { table: "users", column: "id", onDelete: "CASCADE" } },
          created_at: { type: "timestamptz", default: "now()" }
        }
      }
    }
  }

Idempotency: "apply" is safe to call multiple times. If the schema is already up-to-date, returns "Schema is up to date".

Destructive operations: Require explicit opt-in via the _drop (table-level) or _dropColumns (column-level) fields.

Common errors:
  - VALIDATION_INVALID_SCHEMA: schema format does not match the DSL
  - STATE_PREREQUISITE_MISSING: add _drop / _dropColumns to authorize destructive ops
  - QUOTA_TABLE_LIMIT: max 50 tables per app
  - RESOURCE_NOT_FOUND: app_id does not exist`,
    {
      app_id: z.string().describe('The app ID'),
      action: z.enum(['get', 'apply', 'dry_run', 'list_migrations']).describe('The action to perform'),
      schema: SchemaInput.optional().describe('Required for apply/dry_run. The desired database schema.'),
      name: z.string().optional().describe('Optional for apply. Migration name (auto-generated if omitted).'),
    },
    {
      title: 'Manage Schema',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const { app_id, action } = args;
      const need = (cond: unknown, msg: string) =>
        cond ? null : { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };

      switch (action) {
        case 'get': {
          const result = await apiGet(`/v1/${app_id}/schema`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'apply': {
          const err = need(args.schema, '"schema" is required for apply.');
          if (err) return err;
          const result = await apiPost(`/v1/${app_id}/schema/apply`, { schema: args.schema, name: args.name });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'dry_run': {
          const err = need(args.schema, '"schema" is required for dry_run.');
          if (err) return err;
          const result = await apiPost(`/v1/${app_id}/schema/apply`, { schema: args.schema, dry_run: true });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'list_migrations': {
          const result = await apiGet(`/v1/${app_id}/migrations`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
      }
    }
  );
}
