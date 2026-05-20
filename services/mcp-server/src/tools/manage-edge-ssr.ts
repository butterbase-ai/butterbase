import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost } from '../api-client.js';

export function registerManageEdgeSsr(server: McpServer) {
  server.tool(
    'manage_edge_ssr',
    `Manage Edge SSR (Cloudflare Workers) deployments: prebuilt-zip flow, server-side build flow, list history.

Actions:
  - "create":             Create a deployment from a locally-built zip; returns upload URL + deployment_id
  - "start":              Start the deployment after the zip is uploaded; polls until READY/ERROR (≤60s)
  - "create_from_source": Server-side build — Mode 1: create deployment + return upload_url
  - "start_from_source":  Server-side build — Mode 2: kick off the build after source upload
  - "list":               List recent deployments (status, URL, sizes)

Two flows (pick ONE):

  FLOW A — local build (you build with @cloudflare/next-on-pages locally):
    1. Run \`npx @cloudflare/next-on-pages\` then zip the CONTENTS of \`.vercel/output/static/\`
       (cd .vercel/output/static && zip -r ../../../edge-ssr.zip .)
       On Windows use Git Bash or WSL; built-in zip tools use backslashes which break uploads.
    2. action: "create"   → { deployment_id, uploadUrl, expiresIn }
    3. PUT zip to uploadUrl with Content-Type: application/zip
    4. action: "start"    → polls; returns { url, status: "READY" }

  FLOW B — server-side build (Butterbase runs the build for you):
    1. action: "create_from_source"  → { deployment_id, upload_url, max_source_bytes }
    2. PUT source zip (≤50 MB) to upload_url with Content-Type: application/zip
    3. action: "start_from_source" with deployment_id + lockfile_hash (sha256 of package-lock.json)
       → { build_id, status, logs_url, status_url }
    4. Stream logs_url for live build output; poll status_url for terminal status

Parameters by action:
  create:             { app_id, action, framework? }
  start:              { app_id, action, deployment_id }
  create_from_source: { app_id, action, framework? }
  start_from_source:  { app_id, action, deployment_id, lockfile_hash, build_command?, output_dir?, package_manager?, user_env? }
  list:               { app_id, action, limit? }

framework: "nextjs-edge" (default) | "remix-edge" | "other-edge"

Status values: WAITING | UPLOADING | BUILDING | READY | ERROR | CANCELED | TIMEOUT
On TIMEOUT: deployment did not reach a terminal state within 60s. Use action: "list" to check
the current status, or call "start" again if it is still BUILDING.

Plan limits: Free = 1 deployment per app (replaces previous). Starter+ = unlimited.

Common errors:
  - INVALID_STATUS / UPLOAD_EXPIRED: zip not uploaded before "start"
  - STATE_PREREQUISITE_MISSING: source zip not uploaded before "start_from_source"
  - QUOTA_FILE_SIZE_EXCEEDED: source zip exceeds 50 MB
  - RESOURCE_NOT_FOUND: app or deployment doesn't exist
  - EXTERNAL_CLOUDFLARE_ERROR: Workers for Platforms not configured

Build caching (start_from_source):
  lockfile_hash is the node_modules cache key — same hash means cached node_modules (faster builds).
  Compute it with: sha256sum package-lock.json | cut -d' ' -f1`,
    {
      app_id: z.string().describe('The app ID'),
      action: z
        .enum(['create', 'start', 'create_from_source', 'start_from_source', 'list'])
        .describe('The action to perform'),
      framework: z
        .enum(['nextjs-edge', 'remix-edge', 'other-edge'])
        .optional()
        .describe('Framework for create / create_from_source. Default: nextjs-edge.'),
      deployment_id: z.string().optional().describe('Required for start and start_from_source.'),
      limit: z.number().optional().describe('Optional for list. Default: 20.'),
      lockfile_hash: z
        .string()
        .regex(/^[a-f0-9]{8,64}$/, 'lockfile_hash must be a lowercase hex string of 8–64 characters')
        .optional()
        .describe('Required for start_from_source. sha256 of package-lock.json — node_modules cache key.'),
      build_command: z
        .string()
        .optional()
        .describe('start_from_source. Default: "npx @cloudflare/next-on-pages".'),
      output_dir: z
        .string()
        .optional()
        .describe('start_from_source. Default: ".vercel/output/static".'),
      package_manager: z
        .enum(['npm', 'pnpm', 'yarn'])
        .optional()
        .describe('start_from_source. Default: npm.'),
      user_env: z
        .record(z.string(), z.string())
        .optional()
        .describe('start_from_source. Build-time env vars.'),
    },
    {
      title: 'Manage Edge SSR Deployments',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const { app_id, action } = args;
      const need = (cond: unknown, msg: string) =>
        cond
          ? null
          : { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };

      switch (action) {
        case 'create': {
          const result = await apiPost<{ id: string; uploadUrl: string; expiresIn: number }>(
            `/v1/${app_id}/edge-ssr/deployments`,
            { framework: args.framework ?? 'nextjs-edge' }
          );
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(
                { deployment_id: result.id, uploadUrl: result.uploadUrl, expiresIn: result.expiresIn },
                null,
                2,
              ),
            }],
          };
        }

        case 'start': {
          const err = need(args.deployment_id, '"deployment_id" is required for start.');
          if (err) return err;
          const startResult = await apiPost<{ id: string; status: string; url?: string; error?: string }>(
            `/v1/${app_id}/edge-ssr/deployments/${args.deployment_id}/start`,
            {},
          );
          let status = startResult.status;
          let url = startResult.url ?? '';
          let errorMessage = startResult.error ?? '';
          let attempts = 0;
          const maxAttempts = 12; // 60 seconds max (5-second intervals)
          while ((status === 'UPLOADING' || status === 'BUILDING') && attempts < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            const s = await apiGet<{ id: string; status: string; url?: string; error?: string }>(
              `/v1/${app_id}/edge-ssr/deployments/${args.deployment_id}`,
            );
            status = s.status;
            url = s.url ?? url;
            errorMessage = s.error ?? errorMessage;
            attempts++;
          }
          const timedOut = (status === 'UPLOADING' || status === 'BUILDING') && attempts >= maxAttempts;
          const finalStatus = timedOut ? 'TIMEOUT' : status;
          const payload: Record<string, unknown> = { deployment_id: args.deployment_id, status: finalStatus };
          if (url) payload.url = url;
          if (finalStatus === 'ERROR' && errorMessage) payload.error_message = errorMessage;
          if (finalStatus === 'TIMEOUT') {
            payload.message =
              'Deployment did not reach a terminal state within 60 seconds. Use action: "list" to check the current status.';
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
        }

        case 'create_from_source': {
          const result = await apiPost<{
            deployment_id: string;
            build_id: string;
            upload_url: string;
            max_source_bytes: number;
          }>(`/v1/${app_id}/edge-ssr/deployments/from-source`, {
            framework: args.framework ?? 'nextjs-edge',
          });
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(
                {
                  deployment_id: result.deployment_id,
                  build_id: result.build_id,
                  upload_url: result.upload_url,
                  max_source_bytes: result.max_source_bytes,
                },
                null,
                2,
              ),
            }],
          };
        }

        case 'start_from_source': {
          const err =
            need(args.deployment_id, '"deployment_id" is required for start_from_source.') ??
            need(args.lockfile_hash, '"lockfile_hash" is required for start_from_source.');
          if (err) return err;
          const result = await apiPost<{
            build_id: string;
            status: string;
            logs_url: string;
            status_url: string;
          }>(`/v1/${app_id}/edge-ssr/deployments/from-source/${args.deployment_id}/start`, {
            buildCommand: args.build_command ?? 'npx @cloudflare/next-on-pages',
            outputDir: args.output_dir ?? '.vercel/output/static',
            packageManager: args.package_manager ?? 'npm',
            lockfileHash: args.lockfile_hash,
            userEnv: args.user_env ?? {},
          });
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(
                {
                  build_id: result.build_id,
                  status: result.status,
                  logs_url: result.logs_url,
                  status_url: result.status_url,
                },
                null,
                2,
              ),
            }],
          };
        }

        case 'list': {
          const result = await apiGet(`/v1/${app_id}/edge-ssr/deployments`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
      }
    }
  );
}
