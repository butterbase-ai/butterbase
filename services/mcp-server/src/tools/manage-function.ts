import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiDelete, getBaseUrl, getHeaders } from '../api-client.js';

interface ListFunctionsResponse {
  functions: Array<{
    id: string;
    name: string;
    description?: string;
    triggers: Array<{
      type: string;
      config: any;
      enabled?: boolean;
    }>;
    url?: string;
    status: string;
    deployedAt: string;
    lastInvoked?: string;
    lastStatus?: number;
    invocationCount: number;
    errorRate: number;
    avgDuration: number;
    agent_tool?: boolean;
    agent_tool_description?: string | null;
    agent_tool_mode?: 'read_only' | 'read_write' | null;
    agent_tool_exposed_to?: 'developer_only' | 'end_user' | null;
  }>;
}

interface FunctionDetailResponse {
  id: string;
  name: string;
  description?: string;
  code: string;
  triggers: Array<{ type: string; config: unknown; enabled?: boolean }>;
  timeoutMs?: number;
  memoryLimitMb?: number;
  deployedAt: string;
  lastInvoked?: string;
  invocationCount: number;
  errorCount: number;
  avgDuration: number;
  agent_tool?: boolean;
  agent_tool_description?: string | null;
  agent_tool_mode?: 'read_only' | 'read_write' | null;
  agent_tool_exposed_to?: 'developer_only' | 'end_user' | null;
  /** Env-var keys present (values stay encrypted server-side). */
  envKeys?: string[];
}

interface FunctionLogsResponse {
  logs: Array<{
    timestamp: string;
    method?: string;
    path?: string;
    statusCode?: number;
    duration?: number;
    memoryUsed?: number;
    error?: string;
    stack?: string;
    consoleLogs?: Array<{ level: string; message: string; timestamp: number }>;
  }>;
  hasMore: boolean;
}

export function registerManageFunction(server: McpServer) {
  server.tool(
    'manage_function',
    `Manage function lifecycle: list, get source, delete, get logs, and update environment variables.

Actions:
  - "list":       List all deployed functions with status, metrics, and invocation URLs
  - "get":        Retrieve a single function's full detail including its deployed source code
  - "delete":     Delete a deployed function permanently (IRREVERSIBLE)
  - "get_logs":   Retrieve recent invocation logs for debugging and monitoring
  - "update_env": Update environment variables for a deployed function without redeploying code
  - "update_settings": Toggle per-function settings (currently: allow_service_key_impersonation)

Parameters by action:
  list:       { app_id, action: "list" }
  get:        { app_id, action: "get", function_name }
  delete:     { app_id, action: "delete", function_name }
  get_logs:   { app_id, action: "get_logs", function_name, limit?, since?, level?, include_deleted? }
  update_env: { app_id, action: "update_env", function_name, env }
  update_settings: { app_id, action: "update_settings", function_name, allow_service_key_impersonation? }

Common errors:
  - RESOURCE_NOT_FOUND: Function doesn't exist
  - VALIDATION_INVALID_SCHEMA: Invalid parameter format

Idempotency: Safe to call anytime (list is read-only; delete is idempotent; update_env is safe to call multiple times).`,
    {
      app_id: z.string().describe('The app ID'),
      action: z.enum(['list', 'get', 'delete', 'get_logs', 'update_env', 'update_settings']).describe('The action to perform'),
      function_name: z.string().optional().describe('The function name (required for get, delete, get_logs, update_env, update_settings)'),
      // get_logs params
      limit: z.number().optional().describe('Maximum number of logs to return (default: 100)'),
      since: z.string().optional().describe('ISO timestamp to filter logs after this time'),
      level: z.enum(['error', 'all']).optional().describe('Filter by log level (default: all)'),
      include_deleted: z.boolean().optional().describe('Include logs for soft-deleted functions (post-incident forensics). Default: false.'),
      // update_env params
      env: z.record(z.union([z.string(), z.null()])).optional().describe('Environment variables to set (string) or delete (null)'),
      // update_settings params
      allow_service_key_impersonation: z.boolean().optional().describe(
        'Per-function gate (Phase 2). When false, the platform 403s any call ' +
        'carrying X-Butterbase-As-User at the edge — use for admin-only or ' +
        'billing-webhook handlers that must never accept an as-user assertion.'
      ),
    },
    {
      title: 'Manage Function',
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
          const result = await apiGet<ListFunctionsResponse>(`/v1/${args.app_id}/functions`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'get': {
          const err = need(args.function_name, '"function_name" is required for the "get" action.');
          if (err) return err;
          const result = await apiGet<FunctionDetailResponse>(
            `/v1/${args.app_id}/functions/${args.function_name}`
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'delete': {
          const err = need(args.function_name, '"function_name" is required for the "delete" action.');
          if (err) return err;
          await apiDelete(`/v1/${args.app_id}/functions/${args.function_name}`);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    message: 'Function deleted successfully',
                    app_id: args.app_id,
                    function_name: args.function_name,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        case 'get_logs': {
          const err = need(args.function_name, '"function_name" is required for the "get_logs" action.');
          if (err) return err;

          const queryParams = new URLSearchParams();
          if (args.limit) queryParams.set('limit', args.limit.toString());
          if (args.since) queryParams.set('since', args.since);
          if (args.level) queryParams.set('level', args.level);
          if (args.include_deleted) queryParams.set('include_deleted', 'true');

          const url = `/v1/${args.app_id}/functions/${args.function_name}/logs${
            queryParams.toString() ? `?${queryParams.toString()}` : ''
          }`;

          const result = await apiGet<FunctionLogsResponse>(url);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'update_env': {
          const err = need(args.function_name, '"function_name" is required for the "update_env" action.');
          if (err) return err;
          const err2 = need(args.env, '"env" is required for the "update_env" action.');
          if (err2) return err2;

          const url = `${getBaseUrl()}/v1/${args.app_id}/functions/${args.function_name}/env`;
          const res = await fetch(url, {
            method: 'PATCH',
            headers: getHeaders(),
            body: JSON.stringify({ envVars: args.env }),
          });

          const data = await res.json();

          if (!res.ok) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(data, null, 2),
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(data, null, 2),
              },
            ],
          };
        }
        case 'update_settings': {
          const err = need(args.function_name, '"function_name" is required for the "update_settings" action.');
          if (err) return err;
          if (args.allow_service_key_impersonation === undefined) {
            return {
              content: [{ type: 'text' as const, text: 'Error: provide at least one setting to update (currently: allow_service_key_impersonation).' }],
              isError: true,
            };
          }
          const url = `${getBaseUrl()}/v1/${args.app_id}/functions/${args.function_name}/settings`;
          const res = await fetch(url, {
            method: 'PATCH',
            headers: getHeaders(),
            body: JSON.stringify({
              allow_service_key_impersonation: args.allow_service_key_impersonation,
            }),
          });
          const data = await res.json();
          if (!res.ok) {
            return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
        }
      }
    }
  );
}
