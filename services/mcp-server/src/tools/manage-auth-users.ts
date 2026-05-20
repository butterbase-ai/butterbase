import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiDelete } from '../api-client.js';

export function registerManageAuthUsers(server: McpServer) {
  server.tool(
    'manage_auth_users',
    `Manage end-user auth records for an app.

Actions:
  - "list":   Paginated list of app_users (id, email, provider, provider_uid, email_verified,
              last_sign_in_at, created_at). Pass the next_cursor from a prior response to page.
  - "delete": Hard-delete an app user by id. Cascades to refresh tokens and verification codes.
              Use this to unblock OAuth migrations when an existing email/password row collides.

Parameters by action:
  list:   { app_id, action: "list", limit?, cursor? }
  delete: { app_id, action: "delete", user_id }

Tips:
  - Looking for a user by email? Call list and filter client-side; this tool does not search by email.
  - To switch a user from email/password to Google OAuth without deleting, just have them sign in
    with Google — the OAuth callback now links the existing email row in place automatically.`,
    {
      app_id: z.string().describe('The app ID'),
      action: z.enum(['list', 'delete']).describe('The action to perform'),
      user_id: z.string().optional().describe('Required for delete. The app_user UUID to delete.'),
      limit: z.number().int().positive().max(200).optional().describe('Optional for list. 1–200, default 50.'),
      cursor: z.string().optional().describe('Optional for list. Pass next_cursor from a prior response.'),
    },
    {
      title: 'Manage Auth Users',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const { app_id, action } = args;
      switch (action) {
        case 'list': {
          const params = new URLSearchParams();
          if (args.limit) params.set('limit', String(args.limit));
          if (args.cursor) params.set('cursor', args.cursor);
          const qs = params.toString();
          const path = `/v1/${app_id}/admin/auth/users${qs ? `?${qs}` : ''}`;
          const result = await apiGet(path);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'delete': {
          if (!args.user_id) {
            return {
              content: [{ type: 'text' as const, text: 'Error: "user_id" is required for the "delete" action.' }],
              isError: true,
            };
          }
          const result = await apiDelete(`/v1/${app_id}/admin/auth/users/${encodeURIComponent(args.user_id)}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
      }
    }
  );
}
