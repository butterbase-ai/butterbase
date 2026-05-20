import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiPost } from '../api-client.js';

export function registerCreateFrontendDeployment(server: McpServer) {
  server.tool(
    'create_frontend_deployment',
    `Create a frontend deployment and get an upload URL. Upload your built frontend as a zip file to the returned URL, then use manage_frontend (action: "start_deployment") to trigger the deploy.

Steps:
  1. Call this tool to get an upload URL
  2. Upload your zip file to the URL (e.g. curl -X PUT "{uploadUrl}" -H "Content-Type: application/zip" --data-binary @frontend.zip)
  3. Call manage_frontend (action: "start_deployment") with the returned deployment_id

Example:
  Input: { app_id: "app_abc123", framework: "react-vite" }
  Output: {
    deployment_id: "uuid-1234",
    uploadUrl: "https://...",
    expiresIn: 900,
    maxSizeBytes: 104857600
  }

Prerequisites:
  - App must exist (use init_app to create)

Free plan: 1 deployment per app. Deploying again automatically replaces the previous deployment (no need to delete first).
Starter+: unlimited deployments.

Framework options:
  - react-vite: React app built with Vite (zip the dist/ folder)
  - nextjs-static: Next.js static export (zip the out/ folder)
  - static: Plain HTML/CSS/JS
  - other: Any framework that produces static output

SPA routing: For SPA frameworks (react-vite, nextjs-static, other), a _redirects file is auto-injected so all routes serve index.html. If your zip already includes a _redirects file, it is preserved.

IMPORTANT — Zip file paths must use forward slashes (/), not backslashes (\\). On Windows, zips created with built-in tools use backslashes, which causes all files to be served as text/html (breaking JS/CSS with MIME errors). On Windows use Git Bash or WSL to run: cd dist && zip -r ../frontend.zip .

Common errors:
  - RESOURCE_NOT_FOUND: App doesn't exist

Idempotency: Not idempotent — creates a new deployment each time (replaces existing on free plan).

Your frontend will be deployed to https://<app-name>.butterbase.dev.

Next steps: Upload your zip to the returned URL, then call manage_frontend (action: "start_deployment").`,
    {
      app_id: z.string().describe('The app ID'),
      framework: z.enum(['react-vite', 'nextjs-static', 'static', 'other']).optional().describe('Frontend framework type'),
    },
    {
      title: 'Create Frontend Deployment',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const result = await apiPost<{
        id: string;
        uploadUrl: string;
        expiresIn: number;
        maxSizeBytes: number;
      }>(`/v1/${args.app_id}/frontend/deployments`, {
        framework: args.framework,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              deployment_id: result.id,
              uploadUrl: result.uploadUrl,
              expiresIn: result.expiresIn,
              maxSizeBytes: result.maxSizeBytes,
            }, null, 2),
          },
        ],
      };
    }
  );
}
