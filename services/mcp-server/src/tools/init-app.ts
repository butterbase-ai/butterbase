import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiPost, apiGet } from '../api-client.js';

interface InitResponse {
  app_id: string;
  name: string;
  db_provisioned: boolean;
  provisioning_status: string;
  api_url: string;
  [key: string]: unknown;
}

export function registerInitApp(server: McpServer) {
  server.tool(
    'init_app',
    `Create a new backend app with isolated database and API endpoints.

Returns: app_id, api_url, url (frontend URL), and provisioning status.

Example:
  Input: { name: "my-blog" }
  Output: {
    app_id: "app_abc123",
    api_url: "https://api.butterbase.dev/v1/app_abc123",
    url: "https://my-blog.butterbase.dev",
    _meta: { next_actions: [...] }
  }

URL guide:
  - api_url: Your API endpoint for database queries, auth, and functions (e.g. https://api.butterbase.dev/v1/app_abc123)
  - url: Your frontend URL where your deployed site is served (e.g. https://my-blog.butterbase.dev)
  - These are different! The api_url is for backend requests, the url is where users visit your app.

Next steps: Use manage_schema (action: "apply") to define tables, then manage_oauth (action: "configure") for auth.

Common errors:
  - Name already exists: Choose a different name or use manage_app (action: "list") to find existing app
  - Invalid characters: Use only lowercase letters, numbers, hyphens, underscores
  - Name too long: Maximum 63 characters

The response includes _meta.next_actions with recommended next steps.`,
    {
      name: z.string().min(1).max(63).describe('App name (lowercase alphanumeric, hyphens, underscores)'),
      region: z.string().min(1).optional().describe('Region to provision in (e.g. "us-east-1", "us-west-2"). Defaults to the control-api\'s home region.'),
      organization_id: z.string().min(1).optional().describe('Organization to create the app under. Requires membership. Defaults to the API key\'s bound org, or the caller\'s personal org.'),
    },
    {
      title: 'Initialize App',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ name, region, organization_id }) => {
      // Auto-slugify: "My Cool App" → "my-cool-app"
      const slug = name
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/^[^a-z0-9]+/, '')
        .slice(0, 63);

      const body: { name: string; region?: string; organization_id?: string } = { name: slug };
      if (region) body.region = region;
      if (organization_id) body.organization_id = organization_id;
      const result = await apiPost<InitResponse>('/init', body);

      // Poll until provisioned (max ~60s)
      if (result.provisioning_status === 'provisioning') {
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const status = await apiGet<{ provisioning_status: string; provisioning_error?: string }>(
              `/apps/${result.app_id}/status`
            );
            if (status.provisioning_status === 'ready') {
              result.db_provisioned = true;
              result.provisioning_status = 'ready';
              break;
            }
            if (status.provisioning_status === 'failed') {
              result.provisioning_status = 'failed';
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                  ...result,
                  error: status.provisioning_error ?? 'Provisioning failed',
                }, null, 2) }],
                isError: true,
              };
            }
          } catch { break; }
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
