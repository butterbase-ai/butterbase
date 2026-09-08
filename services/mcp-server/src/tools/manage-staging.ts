import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost, apiPut } from '../api-client.js';

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
  "get_env_overrides" — list the KEY NAMES of the staging app's env var
             overrides. Values are never returned.
  "set_env_overrides" — replace this app's staging env var overrides with
             \`env_overrides\`. Pass {} to clear them all. Can be called BEFORE
             "create" — overrides are stored against the production app, so
             setting them first makes staging come up working rather than with
             every key empty. They also survive deleting and re-creating staging.

ENV VARS IN STAGING: production's app-level env var VALUES are deliberately NOT
copied into staging. Each key is created on the staging app with an EMPTY value,
so a function that needs it fails with a missing-key error instead of silently
running against production's live credentials (a staging app holding
production's Stripe key charges real cards). The create job's warnings name
every key that was withheld. Supply sandbox values with "set_env_overrides" —
ideally BEFORE "create", so staging is usable the moment it finishes.

To promote staging changes into production, use the separate promote_staging tool.

Idempotency: "status" and "get_env_overrides" are read-only. "create" refuses
with 409 if a staging environment already exists. "reset" is destructive to the
staging app. "set_env_overrides" is idempotent (it replaces the whole set).`,
    {
      app_id: z.string().describe('The production app id.'),
      action: z.enum(['create', 'status', 'reset', 'get_env_overrides', 'set_env_overrides']),
      env_overrides: z.record(z.string()).optional().describe(
        'For action="set_env_overrides": the staging app\'s env var values, as a '
        + 'flat string->string object. Replaces the whole override set; pass {} to clear.',
      ),
    },
    {
      title: 'Manage Staging Environment',
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
