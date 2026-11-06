import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { finalizeRegisteredTools } from './sdk-tool-registry.js';
import { registerInitApp } from './tools/init-app.js';
import { registerManageSchema } from './tools/manage-schema.js';
import { registerManageRls } from './tools/manage-rls.js';
import { registerManageOAuth } from './tools/manage-oauth.js';
import { registerDocs } from './tools/docs.js';
import { registerManageStorage } from './tools/manage-storage.js';
import { registerQueryAuditLogs } from './tools/query-audit-logs.js';
import { registerDeployFunction } from './tools/deploy-function.js';
import { registerInvokeFunction } from './tools/invoke-function.js';
import { registerManageFunction } from './tools/manage-function.js';
import { registerSubmitSuggestion } from './tools/submit-suggestion.js';
import { registerSelectRows } from './tools/select-rows.js';
import { registerInsertRow } from './tools/insert-row.js';
import { registerCreateFrontendDeployment } from './tools/deploy-frontend.js';
import { registerManageEdgeSsr } from './tools/manage-edge-ssr.js';
import { registerManageFrontend } from './tools/manage-frontend.js';
import { registerManageRealtime } from './tools/manage-realtime.js';
import { registerManageAuthUsers } from './tools/manage-auth-users.js';
import { registerSeedDatabase } from './tools/seed-database.js';
import { registerManageRagContent } from './tools/manage-rag-content.js';
import { registerRagQuery } from './tools/rag-query.js';
import { registerIntegrations } from './tools/integrations.js';
import { registerManageAuthConfig } from './tools/manage-auth-config.js';
import { registerManageApp } from './tools/manage-app.js';
import { registerManageRepo } from './tools/manage-repo.js';
import { registerSubmitHackathonEntry } from './tools/submit-hackathon-entry.js';
import { registerListPartnerApis } from './tools/list-partner-apis.js';
import { registerManageDurableObjects } from './tools/manage-durable-objects.js';
import { registerManageAi } from './tools/manage-ai.js';
import { registerManagePeople } from './tools/manage-people.js';
import { registerBilling } from './tools/billing.js';
import { registerApiKeys } from './tools/api-keys.js';
import { registerListRegions } from './tools/list-regions.js';
import { registerManageMigrations } from './tools/manage-migrations.js';
import { registerManageAgents } from './tools/manage-agents.js';
import { registerManageKv } from './tools/manage-kv.js';
import { registerManagePreview } from './tools/manage-preview.js';
import { registerPromotePreview } from './tools/promote-preview.js';
// MCP initialize response carries an optional `instructions` field that hosts
// pass to the model as system-prompt-adjacent context. Use it to nudge any host
// that surfaces server text (Claude Code, Cursor, VS Code do) toward the right
// onboarding path the moment a user opens a chat after install.
const SERVER_INSTRUCTIONS = [
  'These tools manage a Butterbase backend — databases, functions, storage, auth, AI, RAG, deployments.',
  '',
  'AUTH: tools require an authenticated session. If a tool call returns 401, the user has not yet completed the browser OAuth flow.',
  'Direct them to:',
  '  • Claude Code: run `/mcp` (or `claude mcp login butterbase`)',
  '  • Cursor: Settings → MCP → toggle butterbase on → click "Needs Login"',
  '  • VS Code: ⌘⇧P → "MCP: List Servers" → butterbase → Authenticate',
  '  • Other clients: invoke any butterbase tool — the client should open a browser automatically',
  '',
  'After consent, retry the original tool call.',
].join('\n');

export type ToolRegistrar = (server: McpServer) => void | Promise<void>;

/** Registration only: never starts transports, background tasks or business handlers. */
export async function createRegisteredToolServer(options: {
  registerOverlays?: ToolRegistrar;
  loadOfficeOverlay?: () => Promise<{ registerOfficeMcpTools(server: McpServer): void }>;
} = {}): Promise<McpServer> {
  const server = new McpServer({
    name: 'butterbase',
    version: '0.1.0',
  }, {
    instructions: SERVER_INSTRUCTIONS,
  });

  registerInitApp(server);
  registerManageSchema(server);
  registerManageRls(server);
  registerManageOAuth(server);
  registerDocs(server);
  registerManageStorage(server);
  registerManageKv(server);
  registerQueryAuditLogs(server);
  registerDeployFunction(server);
  registerInvokeFunction(server);
  registerManageFunction(server);
  registerSelectRows(server);
  registerInsertRow(server);
  registerCreateFrontendDeployment(server);
  registerManageEdgeSsr(server);
  registerManageFrontend(server);
  registerSubmitSuggestion(server);
  registerManageRealtime(server);
  registerManageAuthUsers(server);
  registerSeedDatabase(server);
  registerManageRagContent(server);
  registerRagQuery(server);
  registerIntegrations(server);
  registerManageAuthConfig(server);
  registerManageApp(server);
  registerManageRepo(server);
  registerSubmitHackathonEntry(server);
  registerManageDurableObjects(server);
  registerManageAi(server);
  registerManagePeople(server);
  registerBilling(server);
  registerApiKeys(server);
  registerListRegions(server);
  registerManageMigrations(server);
  registerManageAgents(server);
  registerManagePreview(server);
  registerPromotePreview(server);
  if (process.env.PARTNER_PROXY_ENABLED === 'true') {
    registerListPartnerApis(server);
  }

  server.registerPrompt(
    'quickstart',
    {
      description: 'Step-by-step guide to create and configure a Butterbase app',
      argsSchema: {
        app_name: z.string().optional().describe('Name for the new app (e.g. my-app)'),
      },
    },
    async ({ app_name }) => {
      const name = app_name || 'my-app';
      return {
        messages: [
          {
            role: 'assistant' as const,
            content: {
              type: 'text' as const,
              text: [
                `# Butterbase Quickstart`,
                ``,
                `Follow these steps to set up a new backend:`,
                ``,
                `## 1. Create an app`,
                `Call **init_app** with name: "${name}"`,
                ``,
                `## 2. Define your schema`,
                `Call **manage_schema** (action: "apply") with your table definitions (columns, types, indexes).`,
                `Use action: "dry_run" first to preview changes.`,
                ``,
                `## 3. Insert data`,
                `Use **insert_row** or **seed_database** to populate tables.`,
                ``,
                `## 4. Query data`,
                `Use **select_rows** to read data with filters, sorting, and pagination.`,
                ``,
                `## 5. Add auth (optional)`,
                `Call **manage_rls** (action: "enable" or "create_user_isolation").`,
                ``,
                `## 6. Deploy functions (optional)`,
                `Call **deploy_function** with your handler code and trigger config.`,
                ``,
                `## 7. Deploy frontend (optional)`,
                `Call **create_frontend_deployment** (or **deploy_frontend**) then **manage_frontend** (action: "start_deployment").`,
                ``,
                `## Useful tools`,
                `- **manage_app** (action: "list") — see all your apps`,
                `- **manage_schema** (action: "get") — inspect current schema`,
                `- **butterbase_docs** — read full documentation`,
                `- **manage_app** (action: "get_config") — view app settings and API base URL`,
              ].join('\n'),
            },
          },
        ],
      };
    }
  );

  await (options.registerOverlays ?? registerCloudOverlays)(server);
  if (!options.registerOverlays || options.loadOfficeOverlay) {
    try {
      const overlayPath = '../../../cloud-overlays/dist/cloud-overlays/office/mcp-tools/index.js';
      const overlay = options.loadOfficeOverlay ? await options.loadOfficeOverlay() : await import(overlayPath);
      overlay.registerOfficeMcpTools(server);
    } catch (error) {
      if (process.env.OFFICE_MCP_REQUIRED === '1') {
        throw new Error('Office MCP registration failed: the required cloud tool is unavailable.', { cause: error });
      }
      if ((error as { code?: string })?.code !== 'ERR_MODULE_NOT_FOUND') console.warn('Office MCP registration failed; manage_office is unavailable.');
    }
  }
  finalizeRegisteredTools(server);
  return server;
}

/** Missing cloud bundles are optional; a present but broken registration fails closed. */
async function registerCloudOverlays(server: McpServer): Promise<void> {
  for (const [path, registration] of [
    ['../../../cloud-overlays/dist/cloud-overlays/substrate/mcp-tools/index.js', 'registerSubstrateMcpTools'],
    ['../../../cloud-overlays/dist/cloud-overlays/organizations/mcp-tools/index.js', 'registerOrganizationsMcpTools'],
  ]) {
    let overlay;
    try {
      overlay = await import(path);
    } catch (error) {
      // Only absent optional bundles are allowed. Dependency/import errors in an
      // installed overlay must not silently produce a partial executable registry.
      const missing = error as { code?: string; message?: string; url?: string };
      const overlayUrl = new URL(path, import.meta.url);
      const missingTarget = missing.message?.match(/^Cannot find module ['"]([^'"]+)['"]/)?.[1];
      const isMissingOverlay = missing.url
        ? missing.url === overlayUrl.href
        : missingTarget === path || missingTarget?.replaceAll('\\', '/') === fileURLToPath(overlayUrl).replaceAll('\\', '/');
      if (missing.code === 'ERR_MODULE_NOT_FOUND' && isMissingOverlay) continue;
      throw error;
    }
    await overlay[registration](server);
  }
}
