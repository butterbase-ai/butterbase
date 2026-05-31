import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DOC_TOPICS, getUserDocumentation, type DocTopic } from '../docs/user-documentation.js';

export function registerDocs(server: McpServer) {
  server.tool(
    'butterbase_docs',
    `Read comprehensive Butterbase documentation (local, no API calls).

Available topics:
  - all: Complete documentation (default)
  - overview: Platform introduction and key features
  - mcp: MCP tool reference and examples
  - rest: HTTP data API (auto-generated REST endpoints)
  - auth: End-user authentication (OAuth, JWT)
  - storage: File upload/download with S3
  - functions: Serverless functions (triggers, context)
  - frontend: Static frontend deployment (upload zip, deploy to live URL)
  - ai: AI model gateway (chat completions, BYOK, usage)
  - billing: Your Butterbase plan, usage meters, app-level Stripe Connect (subscriptions and one-time payments)
  - platform: MCP over HTTP, /llms.txt, subdomains, suggestions, rate limits
  - regions: Choosing a region at app creation, moving apps between regions, discovering the live region list
  - schema: Schema DSL reference (types, indexes, constraints)
  - sdk: TypeScript SDK installation, client setup, query builder, auth, storage, functions
  - cli: CLI installation, commands for apps, schema, functions, storage, config
  - integrations: Third-party integrations (OAuth connect flow, tool execution, SDK, CLI)
  - substrate: Per-user memory + action coordination plane for AI agents (entities, decisions, attention rules, action ledger, outbox, ws stream, ctx.substrate inside functions)

Example:
  Input: { topic: "auth" }
  Output: Full authentication documentation with OAuth setup, JWT handling, etc.

Use this to:
  - Learn Butterbase features and APIs
  - Get code examples for common tasks
  - Reference schema DSL syntax
  - Understand authentication flow
  - Learn about app monetization (subscriptions and one-time purchases)

Note: This is a local documentation tool. No network requests are made.

Idempotency: Safe to call anytime (read-only operation).`,
    {
      topic: z
        .enum(DOC_TOPICS)
        .optional()
        .describe(
          'Section to return: all (default), overview, mcp, rest, auth, storage, functions, frontend, ai, billing, platform, regions, schema, sdk, cli, realtime, rag, integrations, substrate.'
        ),
    },
    {
      title: 'Butterbase Docs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ topic }) => {
      const t = (topic ?? 'all') as DocTopic;
      const text = getUserDocumentation(t);
      return {
        content: [{ type: 'text' as const, text }],
      };
    }
  );
}
