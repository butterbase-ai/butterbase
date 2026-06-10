// services/mcp-server/src/tools/manage-containers.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost, apiDelete, getBaseUrl, getHeaders } from '../api-client.js';

export function registerManageContainers(server: McpServer) {
  server.tool(
    'manage_container',
    `Manage Containers for an app: deploy an OCI image as a serverless container, list/get/delete, and manage per-container env vars.

Containers run arbitrary Docker images on Cloudflare Containers. Two modes:
  - "pool"  (default): stateless — requests go to any warm instance. For HTTP services, resizers, headless browsers.
  - "actor": one stable instance per key (like a Durable Object with a full container). For game rooms, per-user agents.

M1 flow: docker push your image to the Butterbase registry, then deploy by digest.
(Server-side Dockerfile builds — no local Docker needed — ship in the next milestone.)

Actions:
  - "deploy":   Deploy/update a container from a pushed image digest
  - "list":     List all containers for the app
  - "get":      Get one container (config, status, image)
  - "delete":   Delete a container — running instances stop; cannot be undone
  - "list_env" / "set_env" / "delete_env": per-container env vars (set/delete trigger a redeploy)
  - "registry_credentials": how to docker login + push

Parameters by action:
  deploy: { app_id, action: "deploy", name, image_digest, mode?, access_mode?, instance_type?, max_instances?, sleep_after_s?, port? }
  list:   { app_id, action: "list" }
  get:    { app_id, action: "get", name }
  delete: { app_id, action: "delete", name }
  list_env:   { app_id, action: "list_env", name }
  set_env:    { app_id, action: "set_env", name, key, value }
  delete_env: { app_id, action: "delete_env", name, key }
  registry_credentials: { app_id, action: "registry_credentials" }

URL after deploy:
  https://<subdomain>.butterbase.dev/_containers/<name>            (pool mode)
  https://<subdomain>.butterbase.dev/_containers/<name>/<key>/...  (actor mode; HTTP and WebSocket)

IMPORTANT: redeploys are blue-green — in-memory state in actor containers does NOT survive
an image or config change. Persist durable state to the app DB or storage.

access_mode: "public" | "authenticated" (end-user JWT) | "service_key" (default; Bearer bb_sk_).

Idempotency: deploy/set_env/delete_env are safe to retry. delete is irreversible.`,
    {
      app_id: z.string().describe('The app ID (e.g. app_abc123)'),
      action: z.enum(['deploy', 'list', 'get', 'delete', 'list_env', 'set_env', 'delete_env', 'registry_credentials']).describe('The action to perform'),
      name: z.string().optional().describe('Container name (kebab-case). Required for all actions except list and registry_credentials.'),
      image_digest: z.string().optional().describe('Required for deploy. sha256:... digest of a pushed image.'),
      mode: z.enum(['pool', 'actor']).optional().describe('Optional for deploy. Default: pool.'),
      access_mode: z.enum(['public', 'authenticated', 'service_key']).optional().describe('Optional for deploy. Default: service_key.'),
      instance_type: z.enum(['dev', 'basic', 'standard']).optional().describe('Optional for deploy. Default: basic.'),
      max_instances: z.number().int().optional().describe('Optional for deploy. 1-10, default 5.'),
      sleep_after_s: z.number().int().optional().describe('Optional for deploy. Idle seconds before instance sleeps. Default 300.'),
      port: z.number().int().optional().describe('Optional for deploy. Port your image listens on. Default 8080.'),
      key: z.string().optional().describe('Env var name. Required for set_env and delete_env.'),
      value: z.string().optional().describe('Env var value. Required for set_env.'),
    },
    {
      title: 'Manage Containers',
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
            need(args.image_digest, '"image_digest" is required for deploy.');
          if (err) return err;
          const result = await apiPost<{ id: string; name: string; status: string }>(
            `/v1/${app_id}/containers`,
            {
              name: args.name, image_digest: args.image_digest,
              ...(args.mode ? { mode: args.mode } : {}),
              ...(args.access_mode ? { access_mode: args.access_mode } : {}),
              ...(args.instance_type ? { instance_type: args.instance_type } : {}),
              ...(args.max_instances ? { max_instances: args.max_instances } : {}),
              ...(args.sleep_after_s ? { sleep_after_s: args.sleep_after_s } : {}),
              ...(args.port ? { port: args.port } : {}),
            },
          );
          return {
            content: [{
              type: 'text' as const,
              text: `Deployed container \`${result.name}\` (id: ${result.id}, status: ${result.status}).\nURL: https://<your-app-subdomain>.butterbase.dev/_containers/${result.name}${args.mode === 'actor' ? '/<key>' : ''}`,
            }],
          };
        }
        case 'list': {
          const result = await apiGet(`/v1/${app_id}/containers`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'get': {
          const err = need(args.name, '"name" is required for get.');
          if (err) return err;
          const result = await apiGet(`/v1/${app_id}/containers/${args.name}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'delete': {
          const err = need(args.name, '"name" is required for delete.');
          if (err) return err;
          const result = await apiDelete(`/v1/${app_id}/containers/${args.name}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'list_env': {
          const err = need(args.name, '"name" is required for list_env.');
          if (err) return err;
          const result = await apiGet(`/v1/${app_id}/containers/${args.name}/env`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'set_env': {
          const err =
            need(args.name, '"name" is required for set_env.') ??
            need(args.key, '"key" is required for set_env.') ??
            need(args.value !== undefined, '"value" is required for set_env.');
          if (err) return err;
          const res = await fetch(
            `${getBaseUrl()}/v1/${app_id}/containers/${args.name}/env/${encodeURIComponent(args.key as string)}`,
            { method: 'PUT', headers: getHeaders(), body: JSON.stringify({ value: args.value }) },
          );
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true as const }),
          };
        }
        case 'delete_env': {
          const err =
            need(args.name, '"name" is required for delete_env.') ??
            need(args.key, '"key" is required for delete_env.');
          if (err) return err;
          const headers = getHeaders();
          delete (headers as Record<string, string>)['Content-Type'];
          const res = await fetch(
            `${getBaseUrl()}/v1/${app_id}/containers/${args.name}/env/${encodeURIComponent(args.key as string)}`,
            { method: 'DELETE', headers },
          );
          const text = await res.text();
          const data = text ? JSON.parse(text) : { key: args.key, message: 'Environment variable deleted' };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true as const }),
          };
        }
        case 'registry_credentials': {
          return {
            content: [{
              type: 'text' as const,
              text: [
                `Push images for app ${app_id}:`,
                ``,
                `  docker login registry.butterbase.dev -u app -p <your bb_sk_ key>`,
                `  docker tag my-image registry.butterbase.dev/${app_id}/<container-name>:latest`,
                `  docker push registry.butterbase.dev/${app_id}/<container-name>:latest`,
                ``,
                `The push output shows the sha256 digest — use it as image_digest in action="deploy".`,
                `The bb_sk_ key must belong to this app's owner (keys are user-scoped; create one with manage_api_keys).`,
              ].join('\n'),
            }],
          };
        }
      }
    }
  );
}
