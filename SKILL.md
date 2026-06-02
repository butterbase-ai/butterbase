---
name: butterbase
description: AI-native, open-source backend-as-a-service with a built-in Model Context Protocol server. Postgres, auth, storage, functions, AI gateway.
license: Apache-2.0
category: mcp-servers
supported_assistants:
  - claude-code
  - claude-desktop
  - cursor
  - windsurf
  - codex-cli
homepage: https://butterbase.ai
repository: https://github.com/butterbase-ai/butterbase
mcp:
  npm_package: "@butterbase/mcp"
  hosted_endpoint: https://api.butterbase.ai/mcp
  transport: streamable-http
  registry: io.github.butterbase-ai/mcp
---

# Butterbase

**AI-native, open-source backend-as-a-service** with a built-in Model Context Protocol (MCP) server. Postgres data plane, auth, storage, serverless functions, AI gateway, RAG, realtime, and durable objects — all drivable by an AI agent via MCP tools.

This repo ships the open-source runtime. The managed offering at [butterbase.ai](https://butterbase.ai) adds multi-region orchestration, billing, and ops.

## What the MCP server can do

40+ tools across the platform's surface area, including:

- **Apps & regions** — `init_app`, `manage_app`, `list_regions`, `move_app`
- **Schema** — `manage_schema` (declarative DSL, dry-run diffs), `manage_migrations`
- **Auth** — `manage_auth_config`, `manage_auth_users`, `manage_oauth`
- **Data** — `select_rows`, `insert_row`, `seed_database`
- **Functions** — `deploy_function`, `invoke_function`, `manage_function`
- **Storage** — `manage_storage` (presigned URLs, ACLs)
- **Frontends** — `create_frontend_deployment`, `manage_frontend`, `manage_edge_ssr`
- **RAG** — `manage_rag_content`, `rag_query`
- **Realtime & Durable Objects** — `manage_realtime`, `manage_durable_objects`
- **AI gateway** — `manage_ai` (chat, embeddings, BYOK)
- **Row-Level Security** — `manage_rls`
- **Integrations** — `manage_integrations` (Composio: email, Slack, GitHub, Notion, Linear, CRM)
- **Billing** — `manage_billing` (Stripe Connect)
- **KV, API keys, audit logs**, and more

## Install

### Option 1 — Claude Code plugin (recommended)

```bash
claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills
claude plugin install butterbase
```

Plugin includes 30+ guided skills (`/butterbase-skills:journey`, `/butterbase-skills:build-app`, …) and auto-configures the MCP server.

### Option 2 — Hosted MCP (any client)

Add to your MCP config:

```json
{
  "mcpServers": {
    "butterbase": {
      "url": "https://api.butterbase.ai/mcp",
      "headers": {
        "Authorization": "Bearer ${BUTTERBASE_API_KEY}"
      }
    }
  }
}
```

### Option 3 — Local stdio MCP

```bash
npx @butterbase/mcp
```

Or wire it up in your MCP config:

```json
{
  "mcpServers": {
    "butterbase": {
      "command": "npx",
      "args": ["-y", "@butterbase/mcp"],
      "env": { "BUTTERBASE_API_KEY": "bb_sk_..." }
    }
  }
}
```

### Option 4 — Self-host the whole stack

See the [Quickstart](./README.md#quickstart-self-host) in `README.md`. Requires Docker + Node 22+.

## Get an API key

Sign up at [butterbase.ai](https://butterbase.ai) and generate a key, or self-host and use the CLI:

```bash
butterbase keys generate
```

Keys are prefixed `bb_sk_…`.

## Supported AI assistants

Any MCP-capable client works. Tested with: **Claude Code**, **Claude Desktop**, **Cursor**, **Windsurf**, **Codex CLI**.

## Related

- **[@butterbase/mcp](https://www.npmjs.com/package/@butterbase/mcp)** — stdio MCP server (this repo, installable from npm)
- **[butterbase-skills](https://github.com/butterbase-ai/butterbase-skills)** — Claude Code plugin with 30+ guided skills
- **[@butterbase/sdk](https://www.npmjs.com/package/@butterbase/sdk)** — TypeScript SDK
- **[@butterbase/cli](https://www.npmjs.com/package/@butterbase/cli)** — local dev / scaffolding CLI

## License

Apache-2.0
