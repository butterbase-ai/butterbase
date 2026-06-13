import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiDelete, apiPatch, apiPost } from '../api-client.js';

export function registerManageApp(server: McpServer) {
  server.tool(
    'manage_app',
    `Manage app lifecycle: list, delete, pause/resume, get config, update access mode, secure, update CORS, clone, find templates, and migrate regions.

Actions:
  - "list":                    List all backend apps with basic metadata (no app_id needed)
  - "delete":                  Delete an app and ALL its resources permanently (IRREVERSIBLE)
  - "pause":                   Pause or resume all data-plane traffic for an app (kill-switch)
  - "get_config":              Get detailed configuration for an app including CORS, storage settings, and metadata
  - "set_visibility":          Toggle the app's template visibility between "public" and "private"
  - "update_access_mode":      Toggle an app's access mode between "public" and "authenticated"
  - "secure":                  Lock down an app: sets access_mode to "authenticated" and optionally enables RLS user isolation
  - "update_cors":             Update CORS allowed origins to control which frontend domains can access your API
  - "preview_clone_env_vars":  Preview which env vars a source app's functions need before cloning. Returns { functions: [{ fn_name, keys, conventions }] }. Call this before clone to decide what to supply via env_var_values or auto_mint_api_key.
  - "clone":                   Create a clone of a public app. Returns { job_id, pending_env_vars }. The dest app is a fresh empty-DB app owned by the caller. Source must be public and have a repo snapshot. Supply env_var_values and/or auto_mint_api_key to pre-fill function env vars; pending_env_vars lists keys still needing values.
  - "get_clone_job":           Look up the status of a previously-started clone job. Returns { status, dest_app_id?, error_message? }.
  - "find_templates":          Search public templates by name, region, sort order, and pagination. Returns paginated list of public app templates.
  - "set_clone_webhook":       Set or clear a webhook that fires when someone clones this app. Pass webhook_url + webhook_secret to configure, or clear_webhook: true to remove.
  - "link_substrate":          Link this app to the caller's substrate. Once linked, the app's deployed functions receive ctx.substrate and its actions/entities flow into the caller's substrate ledger.
  - "unlink_substrate":        Unlink this app from substrate. ctx.substrate stops being injected; in-flight actions are unaffected.
  - "move":                    Migrate an app to a different region. Returns migration_id + initial status "queued".
  - "move_status":             Get the current status of an in-progress migration.
  - "teardown_source_replica": After a completed move, decommission the retained source-region replica.

Parameters by action:
  list:                    { action: "list" }
  delete:                  { action: "delete", app_id }
  pause:                   { action: "pause", app_id, paused, reason? }
  get_config:              { action: "get_config", app_id }
  set_visibility:          { action: "set_visibility", app_id, visibility, listed? }
  update_access_mode:      { action: "update_access_mode", app_id, access_mode }
  secure:                  { action: "secure", app_id, tables? }
  update_cors:             { action: "update_cors", app_id, allowed_origins }
  preview_clone_env_vars:  { action: "preview_clone_env_vars", source_app_id }
  clone:                   { action: "clone", source_app_id, name?, region?, env_var_values?, auto_mint_api_key? }
  get_clone_job:           { action: "get_clone_job", job_id }
  find_templates:          { action: "find_templates", q?, region?, sort?, limit?, offset? }
  set_clone_webhook:       { action: "set_clone_webhook", app_id, webhook_url, webhook_secret } or { action: "set_clone_webhook", app_id, clear_webhook: true }
  link_substrate:          { action: "link_substrate", app_id }
  unlink_substrate:        { action: "unlink_substrate", app_id }
  move:                    { action: "move", app_id, dest_region }
  move_status:             { action: "move_status", app_id, migration_id }
  teardown_source_replica: { action: "teardown_source_replica", migration_id }

Common errors:
  - RESOURCE_NOT_FOUND: App doesn't exist, verify app_id with action: "list"
  - AUTH_INVALID_API_KEY: Check your API key is set correctly`,
    {
      action: z.enum(['list', 'delete', 'pause', 'get_config', 'update_access_mode', 'secure', 'update_cors', 'set_visibility', 'preview_clone_env_vars', 'clone', 'get_clone_job', 'find_templates', 'set_clone_webhook', 'link_substrate', 'unlink_substrate', 'move', 'move_status', 'teardown_source_replica'])
        .describe('The action to perform'),
      app_id: z.string().optional().describe('The app ID (e.g. app_abc123def456). Required for all actions except "list".'),
      // pause params
      paused: z.boolean().optional().describe('Required for "pause". true to pause; false to resume.'),
      reason: z.string().max(500).optional().describe('Optional for "pause". Human-readable reason; surfaced in 503 responses while paused.'),
      // update_access_mode params
      access_mode: z.enum(['public', 'authenticated']).optional().describe('Required for "update_access_mode". "public" allows anonymous access, "authenticated" requires end-user JWT or API key.'),
      // set_visibility params
      visibility: z.enum(['private', 'public']).optional().describe('Required for "set_visibility". Template visibility.'),
      listed: z.boolean().optional().describe('Optional for "set_visibility". When false and visibility=public, app is clonable by direct ID but not in /v1/templates.'),
      // secure params
      tables: z.array(z.object({
        table_name: z.string().describe('Table name to enable user isolation on'),
        user_column: z.string().describe('Column storing the user ID (e.g. "user_id", "author_id")'),
        public_read_column: z.string().optional().describe('Optional boolean column (e.g. "is_published"). Creates SELECT policies so all users can read rows where this column is true.'),
      })).optional().describe('Optional for "secure". Tables to enable RLS user isolation on. Omit to only toggle access_mode.'),
      // update_cors params
      allowed_origins: z.array(z.string().url()).min(1).optional().describe('Required for "update_cors". Array of allowed origin URLs (e.g. ["http://localhost:3000", "https://myapp.com"])'),
      // clone params
      source_app_id: z.string().optional().describe('Required for "clone" and "preview_clone_env_vars". The id of the public app to clone.'),
      name: z.string().optional().describe('Optional for "clone". A name for the new app; defaults to `Clone of <source_app_id>`.'),
      region: z.string().optional().describe('Optional for "clone". The region for the new app; defaults to the source app\'s region.'),
      env_var_values: z.record(z.string(), z.record(z.string(), z.string())).optional()
        .describe('Optional for "clone". Per-function env var values: { fn_name: { KEY: "value" } }. Use preview_clone_env_vars to see what keys the source needs.'),
      auto_mint_api_key: z.array(z.object({
        fn_name: z.string(),
        key: z.string(),
      })).optional().describe('Optional for "clone". Keys to auto-mint a scoped bb_sk_* into, typically [{ fn_name: "agent-chat", key: "BUTTERBASE_API_KEY" }].'),
      // get_clone_job params
      job_id: z.string().optional().describe('Required for "get_clone_job".'),
      // set_clone_webhook params
      webhook_url: z.string().url().optional().describe('Required for "set_clone_webhook" (unless clear_webhook is true). HTTPS URL to receive clone event POST requests.'),
      webhook_secret: z.string().min(16).max(256).optional().describe('Required for "set_clone_webhook" (unless clear_webhook is true). Secret used to sign the HMAC-SHA256 webhook payload (16–256 characters).'),
      clear_webhook: z.boolean().optional().describe('Optional for "set_clone_webhook". Pass true to remove the clone webhook instead of setting one.'),
      // find_templates params
      q: z.string().optional().describe('Optional for "find_templates". Search query to filter templates by name.'),
      sort: z.enum(['recent', 'popular']).optional().describe('Optional for "find_templates". Sort order: "recent" or "popular". Defaults to "recent".'),
      limit: z.number().int().optional().describe('Optional for "find_templates". Max results per page (default 20).'),
      offset: z.number().int().optional().describe('Optional for "find_templates". Pagination offset (default 0).'),
      // move / move_status / teardown_source_replica params
      dest_region: z.string().optional().describe('Required for "move". Target region slug (e.g. "us-west-2").'),
      migration_id: z.string().optional().describe('Required for "move_status" and "teardown_source_replica". The migration ID returned by action: "move".'),
    },
    {
      title: 'Manage App',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const { action } = args;
      const need = (cond: unknown, msg: string) =>
        cond ? null : { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };

      switch (action) {
        case 'list': {
          const result = await apiGet('/apps');
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'delete': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const result = await apiDelete(`/apps/${args.app_id}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'pause': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const err2 = need(args.paused !== undefined, '"paused" is required for the "pause" action.');
          if (err2) return err2;
          const result = await apiPatch(`/v1/${args.app_id}/config/pause`, { paused: args.paused, reason: args.reason });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'get_config': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const result = await apiGet(`/v1/${args.app_id}/config`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'update_access_mode': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const err2 = need(args.access_mode, '"access_mode" is required for the "update_access_mode" action.');
          if (err2) return err2;
          const result = await apiPatch(`/v1/${args.app_id}/config/access-mode`, { access_mode: args.access_mode });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'set_visibility': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const err2 = need(args.visibility !== undefined, '"visibility" is required for the "set_visibility" action.');
          if (err2) return err2;
          const body: { visibility: 'private' | 'public'; listed?: boolean } = { visibility: args.visibility! };
          if (args.listed !== undefined) body.listed = args.listed;
          const result = await apiPatch(`/v1/${args.app_id}/config/visibility`, body);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'secure': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const result = await apiPost(`/v1/${args.app_id}/secure`, { tables: args.tables ?? [] });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'update_cors': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const err2 = need(args.allowed_origins, '"allowed_origins" is required for the "update_cors" action.');
          if (err2) return err2;
          const result = await apiPatch(`/v1/${args.app_id}/config/cors`, { allowed_origins: args.allowed_origins });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'preview_clone_env_vars': {
          const err = need(args.source_app_id !== undefined, '"source_app_id" is required for the "preview_clone_env_vars" action.');
          if (err) return err;
          const res = await apiGet(`/v1/templates/${args.source_app_id}/clone-preflight`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
        }
        case 'clone': {
          const err = need(args.source_app_id !== undefined, '"source_app_id" is required for the "clone" action.');
          if (err) return err;
          const body: {
            name?: string;
            region?: string;
            env_var_values?: Record<string, Record<string, string>>;
            auto_mint_api_key?: { fn_name: string; key: string }[];
          } = {};
          if (args.name) body.name = args.name;
          if (args.region) body.region = args.region;
          if (args.env_var_values) body.env_var_values = args.env_var_values;
          if (args.auto_mint_api_key) body.auto_mint_api_key = args.auto_mint_api_key;

          const res = await apiPost<{ job_id: string; status: string }>(
            `/v1/templates/${args.source_app_id}/clone`,
            body,
          );

          // Compute the per-function "still needs values" map from the source's
          // preflight, minus whatever the caller already provided / opted to auto-mint.
          // Soft-fail: if preflight isn't reachable, return the clone result alone —
          // the agent can call get_clone_job later for unfilled_env_vars.
          let pendingEnvVars: Record<string, string[]> = {};
          try {
            type Preflight = { functions: { fn_name: string; keys: string[] }[] };
            const preflight = await apiGet<Preflight>(`/v1/templates/${args.source_app_id}/clone-preflight`);
            const staged = new Set(
              Object.entries(args.env_var_values ?? {})
                .flatMap(([fn, vars]) => Object.keys(vars).map(k => `${fn}:${k}`)),
            );
            const autoMint = new Set(
              (args.auto_mint_api_key ?? []).map(r => `${r.fn_name}:${r.key}`),
            );
            for (const fn of preflight.functions) {
              const unfilled = fn.keys.filter(k => !staged.has(`${fn.fn_name}:${k}`) && !autoMint.has(`${fn.fn_name}:${k}`));
              if (unfilled.length > 0) pendingEnvVars[fn.fn_name] = unfilled;
            }
          } catch {
            // Preflight fetch failed — return clone result without the summary.
          }

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ ...res, pending_env_vars: pendingEnvVars }, null, 2),
            }],
          };
        }
        case 'get_clone_job': {
          const err = need(args.job_id !== undefined, '"job_id" is required for the "get_clone_job" action.');
          if (err) return err;
          const res = await apiGet(`/v1/clone-jobs/${args.job_id}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
        }
        case 'find_templates': {
          const params = new URLSearchParams();
          if (args.q !== undefined) params.append('q', args.q);
          if (args.region !== undefined) params.append('region', args.region);
          if (args.sort !== undefined) params.append('sort', args.sort);
          if (args.limit !== undefined) params.append('limit', String(args.limit));
          if (args.offset !== undefined) params.append('offset', String(args.offset));
          const suffix = params.toString() ? `?${params.toString()}` : '';
          const res = await apiGet(`/v1/templates${suffix}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
        }
        case 'link_substrate': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const result = await apiPost(`/v1/me/apps/${args.app_id}/substrate-link`, {});
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'unlink_substrate': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const result = await apiDelete(`/v1/me/apps/${args.app_id}/substrate-link`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'set_clone_webhook': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          if (args.clear_webhook === true) {
            const result = await apiPatch(`/v1/${args.app_id}/config/clone-webhook`, { clear: true });
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
          }
          const err2 = need(args.webhook_url, '"webhook_url" is required for "set_clone_webhook" unless clear_webhook is true.');
          if (err2) return err2;
          const err3 = need(args.webhook_secret, '"webhook_secret" is required for "set_clone_webhook" unless clear_webhook is true.');
          if (err3) return err3;
          const result = await apiPatch(`/v1/${args.app_id}/config/clone-webhook`, {
            webhook_url: args.webhook_url,
            webhook_secret: args.webhook_secret,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'move': {
          const err =
            need(args.app_id, '"app_id" is required for the "move" action.') ??
            need(args.dest_region, '"dest_region" is required for the "move" action.');
          if (err) return err;
          const result = await apiPost(`/v1/apps/${args.app_id}/move`, { dest_region: args.dest_region });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'move_status': {
          const err =
            need(args.app_id, '"app_id" is required for the "move_status" action.') ??
            need(args.migration_id, '"migration_id" is required for the "move_status" action.');
          if (err) return err;
          const result = await apiGet(`/v1/apps/${args.app_id}/migrations/${args.migration_id}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'teardown_source_replica': {
          const err = need(args.migration_id, '"migration_id" is required for the "teardown_source_replica" action.');
          if (err) return err;
          const result = await apiDelete(`/v1/source-replicas/${args.migration_id}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
      }
    }
  );
}
