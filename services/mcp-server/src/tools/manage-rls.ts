import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost, apiPatch, apiDelete } from '../api-client.js';

export function registerManageRls(server: McpServer) {
  server.tool(
    'manage_rls',
    `Manage Row-Level Security (RLS): enable on tables, create/update/delete policies, list, and one-shot user isolation setup.

Actions:
  - "enable":               Enable RLS on a table (foundation — no policies yet)
  - "create_policy":        Create a custom RLS policy with USING / WITH CHECK expressions
  - "update_policy":        Atomically update an existing policy (drops and re-creates in one tx)
  - "create_user_isolation": One-shot — enable RLS, create policy so users see only their rows, install auto-populate trigger
  - "list":                 List all RLS policies for the app (and tables_with_rls without policies)
  - "delete":               Delete one policy (if policy_name set) or ALL policies on the table (and disable RLS)

Parameters by action:
  enable:                { app_id, action: "enable", table_name }
  create_policy:         { app_id, action: "create_policy", table_name, policy_name, command?, role?, using_expression?, with_check_expression?, restrictive?, user_column? }
  update_policy:         { app_id, action: "update_policy", table_name, policy_name, command?, role?, using_expression?, with_check_expression?, restrictive? }
  create_user_isolation: { app_id, action: "create_user_isolation", table_name, user_column, public_read_column? }
  list:                  { app_id, action: "list" }
  delete:                { app_id, action: "delete", table_name, policy_name? }

Built-in roles (assigned automatically by the platform — you never create them):
  - butterbase_anon:    no auth header → "anon" in policies
  - butterbase_user:    valid end-user JWT → "user" in policies; current_user_id() returns user id
  - butterbase_service: platform API key → automatic full-access bypass; no policy needed

create_policy guidance:
  - command defaults to ALL. SELECT/DELETE: only using_expression. INSERT: only with_check_expression. UPDATE/ALL: both.
  - role: omit to apply to all roles, or set "anon" / "user" to scope and prevent cross-role policy leaks.
  - restrictive: true → policy is AND'd with permissive ones; useful for cross-table checks that must always hold.
  - user_column: pass to install a BEFORE INSERT trigger that auto-fills the column from current_user_id() —
    without it, clients must include the column in POST bodies or insert is rejected with AUTH_RLS_POLICY_VIOLATION.
  - For UUID columns, cast: current_user_id()::uuid

Cross-table subqueries pitfall (ANY policy, USING or WITH CHECK):
  EXISTS/IN/scalar subqueries inside a policy expression read the referenced table THROUGH that table's own RLS,
  under the SAME calling role. Symptom: policy evaluates false and the write fails AUTH_RLS_POLICY_VIOLATION
  (or SELECT returns empty), even for expressions that look trivially true.
  Three flavors:
    1. Referenced table has RLS enabled but NO permissive SELECT policy for role "user"
       → subquery sees 0 rows → EXISTS false. Even a hardcoded EXISTS(SELECT 1 FROM t WHERE id='<real id>') fails.
    2. Referenced table has user_isolation → subquery only sees the CURRENT user's rows, never other users' rows
       (blocks the "user B interacts with user A's public row" pattern).
    3. Referenced table's user_isolation gates by column X, but the subquery keys by column Y
       (e.g. users isolated on "id = current_user_id()" but subquery joins on "auth_user_id = current_user_id()",
        or vice versa). The row exists but isn't visible via the subquery's join column.
  Fix — pick one:
    - Add a permissive SELECT policy for role "user" on the referenced table for the rows the subquery needs
      (create_policy with command: "SELECT", role: "user", using_expression: <predicate>).
    - Or use create_user_isolation with public_read_column to expose specific rows to everyone.
    - Or align the subquery join column with the referenced table's isolation column.

create_user_isolation does:
  1. Enables RLS on the table
  2. User isolation policy (rows where user_column = current_user_id())
  3. Auto-populate trigger for user_column on INSERT
  4. Auto service bypass policy
  5. If public_read_column set: extra SELECT policies for butterbase_user + butterbase_anon
     allowing reads where that boolean column is true ("own rows + public read" pattern in one call)

delete behavior:
  - With policy_name: removes that single policy (RLS stays enabled)
  - Without policy_name: removes ALL policies AND disables RLS — table becomes globally accessible

Common errors:
  - VALIDATION_TABLE_NOT_FOUND: create the table with manage_schema (action: "apply") first
  - VALIDATION_COLUMN_NOT_FOUND: user_column missing from the table
  - VALIDATION_INVALID_TYPE: user_column must be UUID or TEXT
  - RLS_TYPE_MISMATCH: cast types in expressions, e.g. current_user_id()::uuid
  - RLS_INVALID_EXPRESSION: SQL syntax error
  - RESOURCE_NOT_FOUND: policy doesn't exist (update_policy) — use create_policy first

Idempotency: enable, create_policy, update_policy, create_user_isolation, delete — all safe to retry.`,
    {
      app_id: z.string().describe('The app ID'),
      action: z.enum(['enable', 'create_policy', 'update_policy', 'create_user_isolation', 'list', 'delete']).describe('The action to perform'),
      table_name: z.string().optional().describe('Required for enable/create_policy/update_policy/create_user_isolation/delete.'),
      policy_name: z.string().optional().describe('Required for create_policy/update_policy. Optional for delete (omit to remove ALL policies). Alphanumeric + underscores.'),
      command: z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL']).optional().describe('create_policy/update_policy. Default: ALL.'),
      role: z.enum(['anon', 'user']).optional().describe('create_policy/update_policy. Scope to butterbase_anon or butterbase_user. Recommended.'),
      using_expression: z.string().optional().describe('create_policy/update_policy. SQL for USING clause. Required for SELECT/DELETE/ALL/UPDATE.'),
      with_check_expression: z.string().optional().describe('create_policy/update_policy. SQL for WITH CHECK clause. Required for INSERT.'),
      restrictive: z.boolean().optional().describe('create_policy/update_policy. If true, AS RESTRICTIVE policy (AND with permissive).'),
      user_column: z.string().optional().describe('create_policy: install BEFORE INSERT auto-populate trigger. create_user_isolation: required, the user-id column.'),
      public_read_column: z.string().optional().describe('create_user_isolation only. Boolean column — adds SELECT policies for user/anon allowing reads where this is true.'),
    },
    {
      title: 'Manage RLS',
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
        case 'enable': {
          const err = need(args.table_name, '"table_name" is required for enable.');
          if (err) return err;
          const result = await apiPost(`/v1/${app_id}/rls/enable`, { table_name: args.table_name });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'create_policy': {
          const err =
            need(args.table_name, '"table_name" is required for create_policy.') ??
            need(args.policy_name, '"policy_name" is required for create_policy.');
          if (err) return err;
          const result = await apiPost(`/v1/${app_id}/rls/policies`, {
            table_name: args.table_name,
            policy_name: args.policy_name,
            command: args.command,
            role: args.role,
            using_expression: args.using_expression,
            with_check_expression: args.with_check_expression,
            restrictive: args.restrictive,
            user_column: args.user_column,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'update_policy': {
          const err =
            need(args.table_name, '"table_name" is required for update_policy.') ??
            need(args.policy_name, '"policy_name" is required for update_policy.');
          if (err) return err;
          const result = await apiPatch(
            `/v1/${app_id}/rls/policies/${encodeURIComponent(args.policy_name as string)}`,
            {
              table_name: args.table_name,
              command: args.command,
              role: args.role,
              using_expression: args.using_expression,
              with_check_expression: args.with_check_expression,
              restrictive: args.restrictive,
            }
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'create_user_isolation': {
          const err =
            need(args.table_name, '"table_name" is required for create_user_isolation.') ??
            need(args.user_column, '"user_column" is required for create_user_isolation.');
          if (err) return err;
          const result = await apiPost(`/v1/${app_id}/rls`, {
            table_name: args.table_name,
            user_column: args.user_column,
            ...(args.public_read_column && { public_read_column: args.public_read_column }),
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'list': {
          const result = await apiGet<{ policies: unknown[]; tables_with_rls?: string[] }>(`/v1/${app_id}/rls`);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ policies: result.policies, tables_with_rls: result.tables_with_rls ?? [] }, null, 2),
            }],
          };
        }
        case 'delete': {
          const err = need(args.table_name, '"table_name" is required for delete.');
          if (err) return err;
          const url = args.policy_name
            ? `/v1/${app_id}/rls/${args.table_name}/${args.policy_name}`
            : `/v1/${app_id}/rls/${args.table_name}`;
          const result = await apiDelete(url);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
      }
    }
  );
}
