import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost } from '../api-client.js';

export function registerPromotePreview(server: McpServer) {
  server.tool(
    'promote_preview',
    `Push a preview deployment's changes onto the live app.

Copies the preview's STRUCTURE onto its live app — tables, access rules,
functions, Durable Objects, config, the code snapshot — AND DEPLOYS THE
FRONTEND. This is a real deploy to the app real users are on.

Data is never pushed. The live app's rows are never overwritten and never
removed. Only the shape of the database and the application code change. A table
added in the preview is created on the live app EMPTY.

Anything that would throw away live data is refused outright: if pushing would
require deleting a field, deleting a table, changing a field's type, or making an
existing field required, the WHOLE push is blocked and none of it is applied. The
refusal names exactly which statements are stuck, so the user can apply them to
the live app themselves (if they actually intend them) and push again. This is
all-or-nothing on purpose — one blocked statement cancels the five safe ones
alongside it, because a half-updated app is worse off than an un-updated one.

Deletions made only in the preview are KEPT on the live app (a push never deletes
anything) — the "check" action lists these separately as informational, not as
something blocking the push.

Actions:
  "check" — read-only, no side effects. Returns
            { can_promote, additive[], blocked[], ignored_removals[] }.
            \`additive\` is what will be applied; \`blocked\` is what is stuck.
  "run"   — performs the push for real, including a frontend deploy to the live
            app. Returns a job_id; poll GET /v1/clone-jobs/{job_id} for progress.

Always call "check" before "run" so both you and the user know whether the push
will be blocked and what will not carry over. Because "run" deploys to the live
app, CONFIRM WITH THE USER BEFORE CALLING IT — never call "run" unprompted.

Note on naming: the REST paths and some response fields still say "staging" and
"promote" — those are the internal names for the same thing. What the user reads
says "preview" and "push live".`,
    {
      app_id: z.string().describe('The live app id (not the preview app id).'),
      action: z.enum(['check', 'run']),
    },
    {
      title: 'Push Preview Deployment Live',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ app_id, action }) => {
      try {
        const result = action === 'check'
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
