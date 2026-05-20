import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost, apiPatch, apiDelete } from '../api-client.js';

export function registerManageOAuth(server: McpServer) {
  server.tool(
    'manage_oauth',
    `Manage OAuth providers for end-user authentication (configure, get, update, delete).

Actions:
  - "configure": Set up a new OAuth provider (idempotent upsert)
  - "get":       Read provider config (single provider or all). client_secret is redacted.
  - "update":    Patch existing provider — only supplied fields change
  - "delete":    Remove a provider. Existing sessions remain valid until expiry.

Built-in providers (URLs/scopes auto-filled — only client_id, client_secret, redirect_uris required):
  google, github, discord, facebook, linkedin, microsoft, apple, x
For any other provider name, supply authorization_url, token_url, userinfo_url manually.

Parameters by action:
  configure: { app_id, action: "configure", provider, client_id, client_secret, redirect_uris, scopes?, authorization_url?, token_url?, userinfo_url?, provider_metadata? }
  get:       { app_id, action: "get", provider? }   // omit provider to list all
  update:    { app_id, action: "update", provider, ...fields-to-change }
  delete:    { app_id, action: "delete", provider }

Example — configure (Google):
  Input: { app_id: "app_abc123", action: "configure", provider: "google",
           client_id: "...", client_secret: "GOCSPX-...",
           redirect_uris: ["https://api.butterbase.ai/auth/app_abc123/oauth/google/callback"] }

Example — configure (Apple, requires provider_metadata):
  Input: { ..., provider: "apple", provider_metadata: { teamId, keyId, privateKey } }

Provider notes:
  - X (Twitter): no email — synthetic {username}@users.noreply.x.local is used
  - Apple: only returns name on first auth; uses POST callback (handled automatically); requires provider_metadata { teamId, keyId, privateKey }
  - Facebook: default scopes email, public_profile

OAuth flow after configure:
  GET {api_base}/auth/{app_id}/oauth/{provider}?redirect_to=https://yourapp.com/auth/callback
  After successful authentication, user is redirected to redirect_to with tokens as query params.

Common errors:
  - RESOURCE_NOT_FOUND: app or provider doesn't exist
  - VALIDATION_INVALID_SCHEMA: empty client_id/client_secret, or invalid URL on a custom provider

Idempotency: configure/update/delete are safe to retry.

Warning (delete): prevents future sign-ins via that provider; existing sessions remain valid until they expire.`,
    {
      app_id: z.string().describe('The app ID (e.g. app_abc123def456)'),
      action: z.enum(['configure', 'get', 'update', 'delete']).describe('The action to perform'),
      provider: z.string().optional().describe('Provider name. Required for configure/update/delete. Optional for get (omit to list all).'),
      client_id: z.string().optional().describe('OAuth client ID. Required for configure.'),
      client_secret: z.string().optional().describe('OAuth client secret. Required for configure (Apple: placeholder OK; real secret derived from provider_metadata).'),
      redirect_uris: z.array(z.string().url()).optional().describe('Required for configure. Format: ["{api_base}/auth/{app_id}/oauth/{provider}/callback"]'),
      scopes: z.array(z.string()).optional().describe('OAuth scopes. Optional for built-in providers (sensible defaults).'),
      authorization_url: z.string().url().optional().describe('Required for custom providers on configure.'),
      token_url: z.string().url().optional().describe('Required for custom providers on configure.'),
      userinfo_url: z.string().url().optional().describe('Required for custom providers on configure.'),
      provider_metadata: z.record(z.unknown()).optional().describe('Provider-specific metadata. Required for Apple: { teamId, keyId, privateKey }.'),
    },
    {
      title: 'Manage OAuth Providers',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const { app_id, action, provider, ...rest } = args;
      const requireProvider = (a: string) => {
        if (!provider) {
          return {
            content: [{ type: 'text' as const, text: `Error: "provider" is required for the "${a}" action.` }],
            isError: true as const,
          };
        }
        return null;
      };

      switch (action) {
        case 'configure': {
          const err = requireProvider('configure');
          if (err) return err;
          const result = await apiPost(`/v1/${app_id}/auth/oauth-config`, { provider, ...rest });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'get': {
          const endpoint = provider
            ? `/v1/${app_id}/auth/oauth-config/${provider}`
            : `/v1/${app_id}/auth/oauth-config`;
          const result = await apiGet(endpoint);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'update': {
          const err = requireProvider('update');
          if (err) return err;
          const result = await apiPatch(`/v1/${app_id}/auth/oauth-config/${provider}`, rest);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'delete': {
          const err = requireProvider('delete');
          if (err) return err;
          const result = await apiDelete(`/v1/${app_id}/auth/oauth-config/${provider}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
      }
    }
  );
}
