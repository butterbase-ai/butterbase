import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost } from '../api-client.js';

export function registerManageStaging(server: McpServer) {
  server.tool(
    'manage_staging',
    `Create, inspect, or reset an app's staging environment.

A staging environment is a linked sibling app with its own database, storage and
auth users. It starts as a copy of production, including production data.

Actions:
  "create" — provision a staging environment for this app. Returns a job_id;
             poll GET /v1/clone-jobs/{job_id} for progress. One per app.
  "status" — return the linked staging app id and the last promote/reset times,
             or { staging_app_id: null } if there is none.
  "reset"  — discard the staging app's data and re-seed it from production.
             Destructive to staging only; production is never written.

To promote staging changes into production, use the separate promote_staging tool.

Idempotency: "status" is read-only. "create" refuses with 409 if a staging
environment already exists. "reset" is destructive to the staging app.`,
    {
      app_id: z.string().describe('The production app id.'),
      action: z.enum(['create', 'status', 'reset']),
    },
    {
      title: 'Manage Staging Environment',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ app_id, action }) => {
      try {
        const result = action === 'status'
          ? await apiGet(`/v1/apps/${app_id}/staging`)
          : action === 'create'
            ? await apiPost(`/v1/apps/${app_id}/staging`, {})
            : await apiPost(`/v1/apps/${app_id}/staging/reset`, {});
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
      }
    },
  );
}
