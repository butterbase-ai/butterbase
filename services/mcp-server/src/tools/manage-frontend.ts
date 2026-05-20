import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost, apiPatch, apiDelete, getBaseUrl, getHeaders } from '../api-client.js';

export function registerManageFrontend(server: McpServer) {
  server.tool(
    'manage_frontend',
    `Manage frontend deployments, environment variables, and custom domains for a Butterbase app.

Actions:
  - "start_deployment":       Start a frontend deployment after uploading your zip file. Call after uploading zip to the URL returned by create_frontend_deployment. Polls until complete (up to 5 minutes).
  - "list_deployments":       List frontend deployment history for an app (read-only).
  - "create_from_source":     Create a source-based deployment and get a presigned upload URL (Mode 1). Upload your source zip to the URL via HTTP PUT with Content-Type: application/zip (max 50 MB).
  - "start_from_source":      Start the build for a source-based deployment (Mode 2). Requires deployment_id from create_from_source and a lockfile_hash.
  - "set_env":                Set environment variables for frontend builds (upserts).
  - "configure_custom_domain": Manage custom domains. Requires domain_action sub-option.

Parameters by action:
  start_deployment:        { app_id, action: "start_deployment", deployment_id }
  list_deployments:        { app_id, action: "list_deployments" }
  create_from_source:      { app_id, action: "create_from_source" }
  start_from_source:       { app_id, action: "start_from_source", deployment_id, lockfile_hash, build_command?, output_dir?, package_manager?, user_env? }
  set_env:                 { app_id, action: "set_env", vars }
  configure_custom_domain: { app_id, action: "configure_custom_domain", domain_action, hostname?, domain_id? }
    domain_action sub-options:
      "add":    { hostname } — Register a new custom domain
      "list":   {} — List all custom domains for an app
      "status": { domain_id } — Check verification/SSL status of a domain
      "remove": { domain_id } — Remove a custom domain
      "verify": { domain_id } — Trigger re-verification of a pending domain

Common errors:
  - RESOURCE_NOT_FOUND: App or deployment doesn't exist
  - INVALID_STATUS: Deployment is not in WAITING status (zip may not have been uploaded yet)
  - UPLOAD_EXPIRED: The upload URL expired before the zip was uploaded
  - STATE_PREREQUISITE_MISSING: Source zip not yet uploaded (PUT to upload_url first)
  - QUOTA_FILE_SIZE_EXCEEDED: Source zip exceeds 50 MB
  - BUILD_FAILED: Build command exited with non-zero status (check logs_url for details)
  - VALIDATION_INVALID_SCHEMA: vars must be a non-empty object
  - feature_not_available: Free plan — upgrade to Pro (custom domains)
  - RESOURCE_ALREADY_EXISTS: Hostname already registered`,
    {
      app_id: z.string().describe('The app ID'),
      action: z.enum([
        'start_deployment',
        'list_deployments',
        'create_from_source',
        'start_from_source',
        'set_env',
        'configure_custom_domain',
      ]).describe('The action to perform'),
      // start_deployment / start_from_source params
      deployment_id: z.string().optional().describe('The deployment ID (required for "start_deployment" and "start_from_source")'),
      // start_from_source params
      lockfile_hash: z
        .string()
        .regex(/^[a-f0-9]{8,64}$/, 'lockfile_hash must be a lowercase hex string of 8–64 characters')
        .optional()
        .describe('Required for "start_from_source": hex sha256 hash of the lockfile — used as the node_modules cache key'),
      build_command: z
        .string()
        .optional()
        .describe('"start_from_source": build command to run after install (default: npm run build)'),
      output_dir: z
        .string()
        .optional()
        .describe('"start_from_source": output directory containing built static files (default: dist)'),
      package_manager: z
        .enum(['npm', 'pnpm', 'yarn'])
        .optional()
        .describe('"start_from_source": package manager to use for install (default: npm)'),
      user_env: z
        .record(z.string(), z.string())
        .optional()
        .describe('"start_from_source": environment variables to inject during the build (default: {})'),
      // set_env params
      vars: z.record(z.string()).optional().describe('Required for "set_env": environment variables as key-value pairs'),
      // configure_custom_domain params
      domain_action: z
        .enum(['add', 'list', 'status', 'remove', 'verify'])
        .optional()
        .describe('Required for "configure_custom_domain": the domain sub-action to perform'),
      hostname: z.string().optional().describe('Custom domain hostname (required for domain_action "add", e.g. app.example.com)'),
      domain_id: z.string().optional().describe('Domain ID (required for domain_action "status", "remove", "verify")'),
    },
    {
      title: 'Manage Frontend',
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
        case 'start_deployment': {
          const err = need(args.deployment_id, '"deployment_id" is required for the "start_deployment" action.');
          if (err) return err;

          const startResult = await apiPost<{
            id: string;
            status: string;
            url: string;
          }>(`/v1/${args.app_id}/frontend/deployments/${args.deployment_id}/start`, {});

          // Poll for completion
          let status = startResult.status;
          let url = startResult.url;
          let attempts = 0;
          const maxAttempts = 60; // 5 minutes max (5 second intervals)

          while ((status === 'BUILDING' || status === 'UPLOADING') && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 5000));

            const statusResult = await apiGet<{
              id: string;
              status: string;
              url?: string;
            }>(`/v1/${args.app_id}/frontend/deployments/${args.deployment_id}`);
            status = statusResult.status;
            url = statusResult.url || url;
            attempts++;
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  deployment_id: args.deployment_id,
                  url,
                  status,
                }, null, 2),
              },
            ],
          };
        }

        case 'list_deployments': {
          const result = await apiGet(`/v1/${args.app_id}/frontend/deployments`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        case 'create_from_source': {
          const result = await apiPost<{
            deployment_id: string;
            build_id: string;
            upload_url: string;
            max_source_bytes: number;
          }>(`/v1/${args.app_id}/frontend/deployments/from-source`, {});

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  deployment_id: result.deployment_id,
                  build_id: result.build_id,
                  upload_url: result.upload_url,
                  max_source_bytes: result.max_source_bytes,
                }, null, 2),
              },
            ],
          };
        }

        case 'start_from_source': {
          const err = need(args.deployment_id, '"deployment_id" is required for the "start_from_source" action.');
          if (err) return err;
          const err2 = need(args.lockfile_hash, '"lockfile_hash" is required for the "start_from_source" action.');
          if (err2) return err2;

          const result = await apiPost<{
            build_id: string;
            status: string;
            logs_url: string;
            status_url: string;
          }>(`/v1/${args.app_id}/frontend/deployments/from-source/${args.deployment_id}/start`, {
            buildCommand: args.build_command ?? 'npm run build',
            outputDir: args.output_dir ?? 'dist',
            packageManager: args.package_manager ?? 'npm',
            lockfileHash: args.lockfile_hash,
            userEnv: args.user_env ?? {},
          });

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  build_id: result.build_id,
                  status: result.status,
                  logs_url: result.logs_url,
                  status_url: result.status_url,
                }, null, 2),
              },
            ],
          };
        }

        case 'set_env': {
          const err = need(args.vars, '"vars" is required for the "set_env" action.');
          if (err) return err;
          const result = await apiPatch(`/v1/${args.app_id}/frontend/env`, args.vars);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        case 'configure_custom_domain': {
          const err = need(args.domain_action, '"domain_action" is required for the "configure_custom_domain" action.');
          if (err) return err;

          const { domain_action, hostname, domain_id } = args;
          const base = `/v1/${args.app_id}/custom-domains`;

          switch (domain_action) {
            case 'add': {
              if (!hostname) {
                return { content: [{ type: 'text' as const, text: 'Error: "hostname" is required for domain_action "add".' }], isError: true };
              }
              const res = await fetch(`${getBaseUrl()}${base}`, {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify({ hostname }),
              });
              const data = await res.json();
              return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], ...(res.ok ? {} : { isError: true }) };
            }

            case 'list': {
              const result = await apiGet(base);
              return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
            }

            case 'status': {
              if (!domain_id) {
                return { content: [{ type: 'text' as const, text: 'Error: "domain_id" is required for domain_action "status".' }], isError: true };
              }
              const result = await apiGet(`${base}/${domain_id}/status`);
              return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
            }

            case 'remove': {
              if (!domain_id) {
                return { content: [{ type: 'text' as const, text: 'Error: "domain_id" is required for domain_action "remove".' }], isError: true };
              }
              await apiDelete(`${base}/${domain_id}`);
              return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Custom domain removed', domain_id }, null, 2) }] };
            }

            case 'verify': {
              if (!domain_id) {
                return { content: [{ type: 'text' as const, text: 'Error: "domain_id" is required for domain_action "verify".' }], isError: true };
              }
              const result = await apiPost(`${base}/${domain_id}/verify`, {});
              return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
            }

            default: {
              return { content: [{ type: 'text' as const, text: `Error: Unknown domain_action "${domain_action}".` }], isError: true };
            }
          }
        }

        default: {
          return { content: [{ type: 'text' as const, text: `Error: Unknown action "${action}".` }], isError: true };
        }
      }
    }
  );
}
