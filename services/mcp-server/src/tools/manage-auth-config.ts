import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiPatch, getBaseUrl, getHeaders } from '../api-client.js';

interface UpdateJwtConfigResponse {
  message: string;
  app_id: string;
  jwt_config: {
    accessTokenTtl: string;
    refreshTokenTtlDays: number;
  };
}

export function registerManageAuthConfig(server: McpServer) {
  server.tool(
    'manage_auth_config',
    `Manage authentication configuration for an app.

Actions:
  - "configure_auth_hook": Configure a post-authentication hook function
  - "update_jwt":           Update JWT token expiration times
  - "generate_service_key": Generate a new API key (service key)

Parameters by action:
  configure_auth_hook: { app_id, action: "configure_auth_hook", post_auth_function }
  update_jwt:          { app_id, action: "update_jwt", accessTokenTtl?, refreshTokenTtlDays? }
  generate_service_key: { action: "generate_service_key", name }

---

### configure_auth_hook

Configure a post-authentication hook function for an app.

When set, the specified Butterbase function is invoked (fire-and-forget) after
every successful auth event: OAuth login, email login, and email signup.

The hook function receives a JSON POST body:
  {
    "event": "oauth_login" | "signup" | "login",
    "user": { "id": "uuid", "email": "...", "provider": "google", "display_name": "...", "avatar_url": "..." },
    "isNewUser": true | false,
    "provider": "google" | "github" | "email" | ...
  }

The function runs as butterbase_service (RLS bypassed, ctx.user is null).
Use the payload body to identify the user.

Set post_auth_function to null to remove the hook.

Prerequisites: The function must be deployed first (use deploy_function).

Example — set hook:
  Input: { app_id: "app_abc123", action: "configure_auth_hook", post_auth_function: "on-auth" }
  Output: { auth_hook_function: "on-auth", message: "Post-auth hook set to function \\"on-auth\\"" }

Example — remove hook:
  Input: { app_id: "app_abc123", action: "configure_auth_hook", post_auth_function: null }
  Output: { auth_hook_function: null, message: "Post-auth hook removed" }

Common errors:
  - Function not found: Deploy the function first before configuring it as a hook.

Idempotency: Safe to call multiple times (overwrites previous setting).

---

### update_jwt

Update JWT token expiration times for access and refresh tokens.

Example:
  Input: {
    app_id: "app_abc123",
    action: "update_jwt",
    accessTokenTtl: "1h",
    refreshTokenTtlDays: 30
  }
  Output: {
    message: "JWT config updated",
    app_id: "app_abc123",
    jwt_config: {
      accessTokenTtl: "1h",
      refreshTokenTtlDays: 30
    }
  }

Token types:
  - Access token: Short-lived token for API requests (default: 15m)
  - Refresh token: Long-lived token to get new access tokens (default: 7 days)

Time formats:
  - Access token: "15m", "1h", "2h", "1d" (s=seconds, m=minutes, h=hours, d=days)
  - Refresh token: Integer days (7, 30, 90)

Use this to:
  - Increase security with shorter access tokens
  - Improve UX with longer refresh tokens
  - Balance security vs. convenience

Common errors:
  - RESOURCE_NOT_FOUND: App doesn't exist
  - VALIDATION_INVALID_SCHEMA: Check time format is valid

Idempotency: Safe to call multiple times (updates config).

Note: Changes apply to new tokens only. Existing tokens keep their original expiration.

---

### generate_service_key

Generate a new API key (service key) for programmatic access to the Control API.

Use this to:
  - Create API keys for automation scripts
  - Generate keys for CI/CD pipelines
  - Provide keys to team members or services

The generated key (bb_sk_...) can be used to:
  - Access all MCP tools programmatically
  - Call the Control API directly
  - Manage apps, schemas, functions, and data

Example:
  Input: {
    action: "generate_service_key",
    name: "CI/CD Pipeline Key"
  }
  Output: {
    key: "bb_sk_a1b2c3d4e5f6...",
    key_id: "uuid-1234",
    prefix: "bb_sk_a1b2c3",
    name: "CI/CD Pipeline Key",
    created_at: "2024-01-15T10:00:00Z"
  }

IMPORTANT: The full key is only shown ONCE. Store it securely - it cannot be retrieved again.

Common errors:
  - AUTH_INSUFFICIENT_PERMISSIONS: Only authenticated users can generate keys

Idempotency: Not idempotent - creates a new key each time.

Security notes:
  - Keys have full access to all your apps and data
  - Treat keys like passwords - never commit them to git
  - Revoke keys immediately if compromised
  - Use descriptive names to track key usage

Example — with substrate access:
  Input: {
    action: "generate_service_key",
    name: "Agent Key",
    substrate_access: true
  }
  Output: {
    key: "bb_sk_a1b2c3d4e5f6...",
    key_id: "uuid-1234",
    prefix: "bb_sk_a1b2c3",
    name: "Agent Key",
    created_at: "2024-01-15T10:00:00Z"
  }
  Note: key works on app endpoints AND on substrate endpoints for this account.

### generate_service_key (app-scoped, for function impersonation)
Input: {
  app_id: "app_abc123",
  action: "generate_service_key",
  name: "My Function Caller",
  key_scope: "app"
}
Output: { key: "bb_sk_...", scopes: ["app:app_abc123", "ai:gateway"], ... }
Use the returned key with the X-Butterbase-As-User header to invoke auth:required functions.

### generate_service_key (account-scoped, default)
Input: {
  action: "generate_service_key",
  name: "Platform Admin"
}
Output: { key: "bb_sk_...", scopes: ["*"], ... }
Use for AI gateway, integrations, control-API surfaces.`,
    {
      action: z.enum(['configure_auth_hook', 'update_jwt', 'generate_service_key'])
        .describe('The action to perform'),
      // configure_auth_hook params
      app_id: z.string().optional().describe('The app ID (required for configure_auth_hook and update_jwt); also required for generate_service_key when key_scope === \'app\'.'),
      post_auth_function: z.string().nullable().optional()
        .describe('Name of deployed function to call after auth events, or null to remove (configure_auth_hook only)'),
      // update_jwt params
      accessTokenTtl: z.string().optional().describe(
        'Access token TTL (e.g., "15m", "1h", "2h", "1d"). Supports: s (seconds), m (minutes), h (hours), d (days) (update_jwt only)'
      ),
      refreshTokenTtlDays: z.number().int().positive().optional().describe(
        'Refresh token TTL in days (e.g., 7, 30) (update_jwt only)'
      ),
      // generate_service_key params
      name: z.string().optional().describe('Descriptive name for the key (e.g., "Production Deploy Key") (generate_service_key only)'),
      substrate_access: z.boolean().optional()
        .describe('When true, the generated key works for BOTH app operations and substrate operations on the caller\'s substrate. Default false (app-only). (generate_service_key only)'),
      key_scope: z.enum(['account', 'app']).optional()
        .describe(
          "Whether the key is scoped to your whole account or to a single app. " +
          "Use 'app' (required for calling auth:required functions via " +
          "X-Butterbase-As-User impersonation). Use 'account' for platform APIs. " +
          "Default 'account'. (generate_service_key only)"
        ),
      additional_scopes: z.array(z.string()).optional()
        .describe(
          "Optional extra scope tokens to add. Allowed: 'ai:gateway', 'substrate'. " +
          "Do NOT pass 'app:<id>' or '*' — use key_scope instead. (generate_service_key only)"
        ),
    },
    {
      title: 'Manage Auth Config',
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
        case 'configure_auth_hook': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const result = await apiPatch(`/v1/${args.app_id}/config/auth-hooks`, { post_auth_function: args.post_auth_function });
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
        case 'update_jwt': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const body: any = {};
          if (args.accessTokenTtl) body.accessTokenTtl = args.accessTokenTtl;
          if (args.refreshTokenTtlDays !== undefined) body.refreshTokenTtlDays = args.refreshTokenTtlDays;

          const result = await apiPatch<UpdateJwtConfigResponse>(
            `/v1/${args.app_id}/config/jwt`,
            body
          );
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            }],
          };
        }
        case 'generate_service_key': {
          const nameErr = need(args.name, '"name" is required for this action.');
          if (nameErr) return nameErr;

          if (args.key_scope === 'app') {
            const appErr = need(args.app_id, '"app_id" is required when key_scope is "app".');
            if (appErr) return appErr;
          }

          const url = `${getBaseUrl()}/api-keys`;
          const body: Record<string, unknown> = { name: args.name };
          if (args.substrate_access) body.scope = 'both';
          if (args.key_scope) body.key_scope = args.key_scope;
          if (args.key_scope === 'app') body.target_app_id = args.app_id;
          if (args.additional_scopes && args.additional_scopes.length > 0) {
            body.additional_scopes = args.additional_scopes;
          }

          const res = await fetch(url, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(body),
          });

          const data = await res.json();

          if (!res.ok) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
              isError: true as const,
            };
          }

          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
          };
        }
      }
    }
  );
}
