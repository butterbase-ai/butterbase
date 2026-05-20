import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getBaseUrl, getHeaders } from '../api-client.js';

export function registerApiKeys(server: McpServer) {
  server.tool(
    'manage_api_keys',
    `List and revoke API keys (service keys) for the Butterbase platform account.

This is a platform-scoped tool — it operates on the authenticated account, not on a specific app.
To generate a new API key, use manage_auth_config (action: "generate_service_key").

Actions:
  - "list":   List all active API keys on the account (key secrets are NOT returned — only metadata)
  - "revoke": Permanently revoke a specific key by its ID

Parameters by action:
  list:   { action: "list" }
  revoke: { action: "revoke", key_id: "<uuid>" }

Examples:

  List all keys:
    Input:  { action: "list" }
    Output: [
      {
        id: "uuid-1234",
        prefix: "bb_sk_a1b2c3",
        name: "CI/CD Pipeline Key",
        created_at: "2025-01-15T10:00:00Z",
        last_used_at: "2025-04-01T08:30:00Z"
      },
      ...
    ]

  Revoke a key:
    Input:  { action: "revoke", key_id: "uuid-1234" }
    Output: { message: "API key revoked", key_id: "uuid-1234" }

Workflow — rotate a key:
  1. Call "list" to identify the key by name or prefix
  2. Call manage_auth_config (action: "generate_service_key") to create the replacement key (store the new secret immediately)
  3. Update all consumers (CI, scripts, MCP config) with the new key
  4. Call "revoke" with the old key_id to invalidate it

Common errors:
  - AUTH_INSUFFICIENT_PERMISSIONS: Must be authenticated as the account owner
  - RESOURCE_NOT_FOUND: key_id does not exist or belongs to a different account

Security notes:
  - Revocation is immediate and irreversible
  - If a key is compromised, revoke it before generating a replacement to minimise exposure window`,
    {
      action: z
        .enum(['list', 'revoke'])
        .describe('The action to perform on API keys'),
      key_id: z
        .string()
        .optional()
        .describe('The UUID of the API key to revoke (required for "revoke")'),
    },
    {
      title: 'Manage API Keys',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const { action, key_id } = args;

      switch (action) {
        case 'list': {
          const res = await fetch(`${getBaseUrl()}/api-keys`, {
            headers: getHeaders(),
          });
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true }),
          };
        }

        case 'revoke': {
          if (!key_id) {
            return {
              content: [{ type: 'text' as const, text: 'Error: "key_id" is required for the "revoke" action.' }],
              isError: true,
            };
          }
          const headers = getHeaders();
          // DELETE has no body — remove Content-Type to avoid Fastify JSON parser failing on empty body
          delete (headers as Record<string, string>)['Content-Type'];
          const res = await fetch(`${getBaseUrl()}/api-keys/${key_id}`, {
            method: 'DELETE',
            headers,
          });
          const text = await res.text();
          const data = text ? JSON.parse(text) : { message: 'API key revoked', key_id };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true }),
          };
        }
      }
    }
  );
}
