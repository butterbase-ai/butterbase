import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet } from '../api-client.js';

interface AuditLog {
  id: string;
  app_id: string;
  category: 'auth' | 'admin' | 'function';
  event_type: string;
  action: string | null;
  resource_type: string | null;
  resource_id: string | null;
  actor_type: string;
  actor_id: string | null;
  event_data: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  success: boolean;
  error_message: string | null;
  correlation_id: string | null;
  created_at: string;
}

interface QueryAuditLogsResponse {
  logs: AuditLog[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

export function registerQueryAuditLogs(server: McpServer) {
  server.tool(
    'query_audit_logs',
    `Query audit events for an app — authentication, admin mutations, and function invocations.

Returns a unified event stream. Each event has:
  category       'auth' | 'admin' | 'function'
  event_type     e.g. 'login', 'schema.apply', 'function.deploy', 'function.invoke'
  action         'create' | 'update' | 'delete' | 'invoke' | 'enable' | 'disable' | null
  resource_type  which resource the event acted on
  resource_id    the resource identifier (function name, policy name, deployment id, etc.)
  actor_type     'platform_user' | 'app_user' | 'api_key' | 'system' | 'anonymous'
  actor_id       platform user id / app user id / api key id
  event_data     event-specific payload
  success        whether the event succeeded
  correlation_id request id (ties related events together)

Use this to:
  - Investigate who did what and when
  - Debug failing auth / admin / function flows
  - Monitor suspicious activity
  - Trace a request across subsystems via correlation_id

Common filters:
  - category='admin' to see only administrative mutations
  - resource_type='function' + resource_id='my-fn' to see one function's history
  - actor_id=<user-id> to see one actor's activity
  - from / to to narrow to a time window

Idempotency: Safe to call anytime (read-only). Historical auth events predating migration 034 are included (normalized).`,
    {
      app_id: z.string().describe('The app ID (e.g. app_abc123def456)'),
      category: z.enum(['auth', 'admin', 'function']).optional().describe('Event category filter'),
      event_type: z.string().optional().describe('Exact event type match (e.g. "login", "schema.apply", "function.invoke")'),
      action: z.enum(['create', 'update', 'delete', 'invoke', 'enable', 'disable']).optional().describe('Action filter'),
      resource_type: z.string().optional().describe('Resource type filter (e.g. "function", "rls_policy")'),
      resource_id: z.string().optional().describe('Resource identifier filter'),
      actor_id: z.string().optional().describe('Actor ID filter (platform user, app user, or API key id)'),
      user_id: z.string().optional().describe('DEPRECATED — alias for actor_id'),
      from: z.string().optional().describe('ISO-8601 timestamp, inclusive lower bound on created_at'),
      to: z.string().optional().describe('ISO-8601 timestamp, exclusive upper bound on created_at'),
      limit: z.number().int().positive().max(500).optional().default(100).describe('Number of logs to return (default 100, max 500)'),
      offset: z.number().int().min(0).optional().default(0).describe('Pagination offset (default 0)'),
    },
    {
      title: 'Query Audit Logs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const { app_id, ...filters } = args;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) {
        if (v !== undefined && v !== null && v !== '') {
          params.append(k, String(v));
        }
      }
      const queryString = params.toString();
      const endpoint = queryString
        ? `/v1/${app_id}/audit-logs?${queryString}`
        : `/v1/${app_id}/audit-logs`;

      const result = await apiGet<QueryAuditLogsResponse>(endpoint);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
