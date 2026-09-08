import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost } from '../api-client.js';

export function registerPromoteStaging(server: McpServer) {
  server.tool(
    'promote_staging',
    `Apply a staging environment's changes to production.

Promotes schema, RLS policies, functions, Durable Objects, config, the repo
snapshot, AND DEPLOYS THE FRONTEND from the staging app to its production app.
This is a real production deploy.

Data is never promoted — production rows are never overwritten or removed.
Only the shape of the database (schema, RLS, functions, etc.) and the
application code are affected.

Destructive schema changes are refused outright: if promoting would require
dropping a column, dropping a table, changing a column's type, or adding a
NOT NULL constraint, the whole promote is blocked and none of it is applied.
The refusal names exactly which SQL statements are stuck so you can apply
them to production yourself (if you actually intend them) and promote again.
Table/column removals made only in staging are silently kept in production
(promote never deletes them) — the "preview" action lists these separately
as informational, not as something blocking the promote.

Actions:
  "preview" — read-only, no side effects. Returns
              { can_promote, additive[], blocked[], ignored_removals[] }.
  "run"     — starts the promote for real, including a frontend deploy to
              production. Returns a job_id; poll GET /v1/clone-jobs/{job_id}
              for progress.

Always call "preview" before "run" so you and the user know whether the
promote will be blocked and what will not carry over. Because "run" deploys
to production, confirm with the user before calling it — do not call "run"
unprompted.`,
    {
      app_id: z.string().describe('The production app id (not the staging app id).'),
      action: z.enum(['preview', 'run']),
    },
    {
      title: 'Promote Staging to Production',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ app_id, action }) => {
      try {
        const result = action === 'preview'
          ? await apiGet(`/v1/apps/${app_id}/staging/promote/preview`)
          : await apiPost(`/v1/apps/${app_id}/staging/promote`, {});
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
      }
    },
  );
}
