import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost, apiDelete, getBaseUrl, getHeaders } from '../api-client.js';

export function registerManageDurableObjects(server: McpServer) {
  server.tool(
    'manage_durable_objects',
    `Manage Durable Object (DO) classes for an app: register/update code, list/get/delete, view usage, and manage shared env vars.

DOs are stateful per-key actors that persist state in memory and built-in storage. Use them when
you need state for a single room/user/agent across requests (multiplayer games, chat rooms, rate
limiters, long-running agents). For stateless work, use a Function instead.

Actions:
  - "deploy":     Register or update a DO class (single TypeScript file, one exported class)
  - "list":       List all DO classes for the app
  - "get":        Get a single DO class — includes the source code and current status
  - "delete":     Delete a DO class — Cloudflare immediately deletes all instances and storage; cannot be undone
  - "usage":      Get current-month DO usage (do_requests, do_cpu_ms) — refreshed every 15 min, app-wide totals
  - "list_env":   List all env vars set on the app's DOs
  - "set_env":    Create or overwrite a single env var
  - "delete_env": Remove a single env var

Parameters by action:
  deploy:     { app_id, action: "deploy", name, code, access_mode? }
  list:       { app_id, action: "list" }
  get:        { app_id, action: "get",    name }
  delete:     { app_id, action: "delete", name }
  usage:      { app_id, action: "usage",  name }
  list_env:   { app_id, action: "list_env" }
  set_env:    { app_id, action: "set_env",    key, value }
  delete_env: { app_id, action: "delete_env", key }

Deploy constraints:
  - One TypeScript file, exporting exactly ONE class with fetch(req) and optional state.storage / state.acceptWebSocket
  - No npm imports — only \`import { ... } from 'cloudflare:workers'\`
  - Max 5 DO classes per app. Bundle (sum of all DO code per app) ≤ 10 MB compressed.
  - Class name in code (PascalCase) is parsed automatically; URL "name" arg is kebab-case.

URL after deploy:
  https://<subdomain>.butterbase.dev/_do/<name>/<instance-id>   (HTTP and WebSocket)

access_mode (v1 — shape check only at the dispatcher; validate inside fetch() for strong auth):
  - "public":         open to anyone
  - "authenticated":  requires Authorization that looks like an end-user JWT (default)
  - "service_key":    requires Authorization starting with "Bearer bb_sk_"

Env vars are key-value pairs injected into every DO class at runtime, scoped to all DO classes within
the app. They are separate from function env vars. After set_env / delete_env, redeploy DOs for the
change to take effect.

Common errors:
  - RESOURCE_NOT_FOUND: app_id or DO class doesn't exist
  - AUTH_INSUFFICIENT_PERMISSIONS: must be app owner or collaborator
  - VALIDATION_ERROR: env key must be alphanumeric + underscores; class code must export exactly one class

Idempotency: deploy/set_env/delete_env are safe to retry. delete is irreversible.`,
    {
      app_id: z.string().describe('The app ID (e.g. app_abc123)'),
      action: z.enum(['deploy', 'list', 'get', 'delete', 'usage', 'list_env', 'set_env', 'delete_env']).describe('The action to perform'),
      name: z.string().optional().describe('DO class URL name (kebab-case). Required for deploy/get/delete/usage.'),
      code: z.string().optional().describe('Required for deploy. TypeScript source — must export exactly one class.'),
      access_mode: z.enum(['public', 'authenticated', 'service_key']).optional().describe('Optional for deploy. Default: authenticated.'),
      key: z.string().optional().describe('Env var name. Required for set_env and delete_env.'),
      value: z.string().optional().describe('Env var value. Required for set_env.'),
    },
    {
      title: 'Manage Durable Objects',
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
        case 'deploy': {
          const err =
            need(args.name, '"name" is required for deploy.') ??
            need(args.code, '"code" is required for deploy.');
          if (err) return err;
          const result = await apiPost<{ id: string; name: string; status: string }>(
            `/v1/${app_id}/durable-objects`,
            { name: args.name, code: args.code, access_mode: args.access_mode ?? 'authenticated' },
          );
          return {
            content: [{
              type: 'text' as const,
              text: `Deployed Durable Object \`${result.name}\` (id: ${result.id}, status: ${result.status}).\nURL: https://<your-app-subdomain>.butterbase.dev/_do/${result.name}/<instance-id>`,
            }],
          };
        }
        case 'list': {
          const result = await apiGet(`/v1/${app_id}/durable-objects`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'get': {
          const err = need(args.name, '"name" is required for get.');
          if (err) return err;
          const result = await apiGet(`/v1/${app_id}/durable-objects/${args.name}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'delete': {
          const err = need(args.name, '"name" is required for delete.');
          if (err) return err;
          const result = await apiDelete(`/v1/${app_id}/durable-objects/${args.name}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'usage': {
          const err = need(args.name, '"name" is required for usage.');
          if (err) return err;
          const result = await apiGet(`/v1/${app_id}/durable-objects/${args.name}/usage`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'list_env': {
          const res = await fetch(`${getBaseUrl()}/v1/${app_id}/durable-objects/env`, { headers: getHeaders() });
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true as const }),
          };
        }
        case 'set_env': {
          const err =
            need(args.key, '"key" is required for set_env.') ??
            need(args.value !== undefined, '"value" is required for set_env.');
          if (err) return err;
          const res = await fetch(
            `${getBaseUrl()}/v1/${app_id}/durable-objects/env/${encodeURIComponent(args.key as string)}`,
            { method: 'PUT', headers: getHeaders(), body: JSON.stringify({ value: args.value }) },
          );
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true as const }),
          };
        }
        case 'delete_env': {
          const err = need(args.key, '"key" is required for delete_env.');
          if (err) return err;
          const headers = getHeaders();
          delete (headers as Record<string, string>)['Content-Type'];
          const res = await fetch(
            `${getBaseUrl()}/v1/${app_id}/durable-objects/env/${encodeURIComponent(args.key as string)}`,
            { method: 'DELETE', headers },
          );
          const text = await res.text();
          const data = text ? JSON.parse(text) : { key: args.key, message: 'Environment variable deleted' };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true as const }),
          };
        }
      }
    }
  );
}
