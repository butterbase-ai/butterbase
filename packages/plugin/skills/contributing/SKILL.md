---
name: contributing
description: Use when contributing to the Butterbase codebase, adding new MCP tools, creating API routes, writing migrations, or understanding the monorepo architecture
---

## 1. Overview

Contributor guide for the Butterbase monorepo. Covers architecture, how to add MCP tools, API routes, database migrations, and coding conventions.

---

## 2. Monorepo Map

| Directory | Package | Purpose |
|-----------|---------|---------|
| `packages/cli` | `@butterbase/cli` (v0.1.3) | Published CLI tool (Commander.js). Commands: init, apps, schema, functions, storage, deploy, data, env, keys, realtime, status, open |
| `packages/sdk` | `@butterbase/sdk` (v1.2.1) | Published TypeScript SDK. Modules: auth, storage, functions, AI, billing, realtime, admin |
| `packages/shared` | `@butterbase/shared` | Internal shared types, constants, schema DSL, error types |
| `packages/plugin` | `@butterbase/plugin` | Claude Code plugin (this package — skills for AI agents) |
| `services/control-api` | `@butterbase/control-api` | Fastify API server — the brain. Routes, plugins, services. Port 4000 |
| `services/mcp-server` | `@butterbase/mcp-server` | MCP server with 42+ tools. Runs via stdio or HTTP (served by control-api at `/mcp`) |
| `services/deno-runtime` | — | Serverless function executor. Deno-based worker isolation. Port 7133 |
| `services/cron-scheduler` | `@butterbase/cron-scheduler` | Cron job runner using node-cron + cron-parser |
| `services/dashboard` | — | React management UI (Vite + Radix UI) |
| `services/dashboard-api` | — | Dashboard backend proxy. Port 4100 |
| `services/docs` | `@butterbase/docs` | Astro/Starlight documentation site |
| `services/storage-indexer` | — | Cloudflare Worker for S3 event indexing |
| `db/control-plane` | — | SQL migrations (001_ through 027_). Control plane database schema |
| `db/data-plane` | — | Per-app database initialization scripts |

---

## 3. Adding a New MCP Tool (4 Steps)

### Step 1: Create tool file at `services/mcp-server/src/tools/my-new-tool.ts`

Follow the pattern from existing tools like `init-app.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiPost } from '../api-client.js';

interface MyResponse {
  // response shape
}

export function registerMyNewTool(server: McpServer) {
  server.tool(
    'my_new_tool',      // snake_case name
    `Tool description.   // Multi-line description with examples

Example:
  Input: { ... }
  Output: { ... }

Common errors:
  - ERROR_CODE: Description`,
    {
      // Zod schema for parameters
      app_id: z.string().describe('The app ID'),
      param: z.string().describe('Parameter description'),
    },
    async ({ app_id, param }) => {
      const result = await apiPost<MyResponse>(`/v1/${app_id}/my-endpoint`, { param });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
```

API client functions available: `apiGet`, `apiPost`, `apiPatch`, `apiDelete` (from `../api-client.js`).

### Step 2: Register in `services/mcp-server/src/create-server.ts`

```typescript
import { registerMyNewTool } from './tools/my-new-tool.js';
// ...
registerMyNewTool(server);
```

### Step 3: Create the backing API route in `services/control-api/src/routes/`

- Fastify route handler matching the endpoint your tool calls
- Register in `services/control-api/src/index.ts`

### Step 4: Update documentation in `services/mcp-server/src/docs/user-documentation.ts`

- Add tool to the relevant section's table in the `SECTIONS` object

---

## 4. Adding a Database Migration

- **IMPORTANT**: Use `scripts/migrate.ts` or `scripts/backfill-migrations.ts`, NEVER raw `psql`
- Migration files: `db/control-plane/NNN_description.sql` (sequential numbering)
- Current range: `001_initial_schema.sql` through `027_storage_object_visibility.sql`
- Run migrations: `npx tsx scripts/migrate.ts`

---

## 5. Coding Conventions

| Convention | Example |
|-----------|---------|
| MCP tool names | `snake_case`: `init_app`, `apply_schema`, `get_rls_policies` |
| App IDs | `app_` prefix: `app_abc123` |
| Service keys | `bb_sk_` prefix: `bb_sk_a1b2c3...` |
| Environment variables | `BUTTERBASE_` prefix: `BUTTERBASE_API_KEY` |
| Response metadata | `_meta.next_actions` (suggested next tool calls), `_meta.resource_info` (quota/state) |
| Error codes | `UPPERCASE_WITH_UNDERSCORES`: `AUTH_RLS_POLICY_VIOLATION`, `QUOTA_TABLE_LIMIT` |
| Domain | `butterbase.ai` (never "nira") |

---

## 6. Running Locally

```bash
docker-compose -f docker-compose.local.yml up
```

| Service | Port | URL |
|---------|------|-----|
| Control API | 4000 | `http://localhost:4000` |
| Dashboard API | 4100 | `http://localhost:4100` |
| Deno Runtime | 7133 | `http://localhost:7133` |
| Control Plane DB | 5433 | `postgres://localhost:5433` |
| Data Plane DB | 5435 | `postgres://localhost:5435` |
| PgBouncer | 6432 | `postgres://localhost:6432` |
| LocalStack (S3) | 4566 | `http://localhost:4566` |

---

## 7. Testing

- Framework: Vitest
- Run tests per workspace: `cd services/control-api && npm test`
- Test files: `__tests__/` directory or co-located `*.test.ts`
- Build all workspaces: `npm run build` (from repo root)
- Type check: `npx tsc --noEmit` in each workspace
