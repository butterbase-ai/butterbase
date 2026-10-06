import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost, apiPut } from '../api-client.js';

export function registerManagePreview(server: McpServer) {
  server.tool(
    'manage_preview',
    `Create, inspect, or re-copy an app's preview deployment.

A preview deployment is a copy of the live app that the user can safely break.
It is a separate app with its own database, its own files and its own sign-ups,
so nothing done in it reaches the app real users are on. Note this is a whole
second app, not a frontend deploy.

WHAT IT CONTAINS. A preview starts as a copy of the live app: its tables, its
functions, its access rules, and the live app's DATA — every table's rows, every
signed-up account (with password hashes, so people sign in with the passwords
they already have), and every uploaded file. That includes any personal data the
live app holds about its users. TELL THE USER THIS BEFORE CREATING ONE.

What deliberately does NOT travel:
  - The VALUES of app-level secrets and API keys (see SECRETS below).
  - Connected third-party accounts. The records are copied and then disconnected,
    and integrations and scheduled jobs are switched off, so a preview cannot act
    as the user against Stripe, Google or anything else. Reconnect on the preview
    if needed.
  - Billing and analytics history (subscriptions, orders, daily activity): that
    belongs to the live app.
  - Uploaded file IDs change. If the app stores a file id inside one of its own
    tables, that column still points at the live app's copy of the file.
On a self-hosted deployment without the app-copy engine, a preview is populated
from tables marked _seed:true only; the create/reset job says so in its warnings.

Actions:
  "create" — provision a preview deployment for this app. Needs Launch or a paid
             plan above it (the free Playground plan is not allowed). A preview
             counts as one project against the plan's max_projects limit, so
             creating when the limit is reached fails with 403 (the message names
             the current count and the limit). A plan without previews at all also
             fails with 403. Returns a job_id; poll GET /v1/clone-jobs/{job_id}
             for progress. One per app.
             The job reaches status "copying_data" once the app exists and the
             data copy is running, and only reports "completed" once that copy has
             finished — a job that is not "completed" is not a usable preview, and
             the preview app is not linked or listed by "status" until it is.
  "status" — return the linked preview app id and the last push-live/re-copy
             times, or { staging_app_id: null } if there is none.
  "reset"  — throw away the preview's data and copy it fresh from the live app.
             Destructive to the preview only; the live app is never written to.
             Same "copying_data" then "completed" progression as create.
  "get_env_overrides" — list the KEY NAMES of the preview's secret overrides.
             Values are never returned.
  "set_env_overrides" — replace this app's preview secret overrides with
             \`env_overrides\`. Pass {} to clear them all. Can be called BEFORE
             "create" — overrides are stored against the live app, so setting them
             first makes the preview come up working rather than with every key
             empty. They also survive deleting and re-creating the preview.

SECRETS: the live app's secret VALUES are deliberately NOT copied into a preview.
Each key is created on the preview app with an EMPTY value, so a function that
needs it fails with a missing-key error instead of quietly running against live
credentials (a preview holding the live Stripe key charges real cards). The
create job's warnings name every key that was withheld. Supply test values with
"set_env_overrides" — ideally BEFORE "create", so the preview is usable the
moment it finishes.

To push a preview's changes onto the live app, use the separate promote_preview
tool.

Note on naming: the REST paths and some response fields still say "staging" —
that is the internal name for the same thing. What the user reads says "preview".

Idempotency: "status" and "get_env_overrides" are read-only. "create" refuses
with 409 if a preview already exists. "reset" is destructive to the preview app.
"set_env_overrides" is idempotent (it replaces the whole set).`,
    {
      app_id: z.string().describe('The live app id.'),
      action: z.enum(['create', 'status', 'reset', 'get_env_overrides', 'set_env_overrides']),
      env_overrides: z.record(z.string()).optional().describe(
        "For action=\"set_env_overrides\": the preview app's secret values, as a "
        + 'flat string->string object. Replaces the whole override set; pass {} to clear.',
      ),
    },
    {
      title: 'Manage Preview Deployment',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ app_id, action, env_overrides }) => {
      try {
        if (action === 'set_env_overrides' && !env_overrides) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: action="set_env_overrides" requires env_overrides '
                + '(pass {} to clear all overrides).',
            }],
            isError: true as const,
          };
        }
        const result = action === 'status'
          ? await apiGet(`/v1/apps/${app_id}/staging`)
          : action === 'get_env_overrides'
            ? await apiGet(`/v1/apps/${app_id}/staging/env-overrides`)
            : action === 'set_env_overrides'
              ? await apiPut(`/v1/apps/${app_id}/staging/env-overrides`, { env_overrides })
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
