---
title: Claude Code Plugin
description: Claude Code plugin with guided skills for building, deploying, and debugging Butterbase apps.
---

**Butterbase Skills** is a Claude Code plugin that auto-configures the Butterbase MCP server and provides guided skills for common workflows.

## Installation

```bash
# Add the Butterbase marketplace
claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills

# Install the plugin
claude plugin install butterbase-skills@butterbase-skills
```

Set your API key:

```bash
export BUTTERBASE_API_KEY=bb_sk_your_key_here
```

## What's included

### MCP Server Auto-Configuration

The plugin includes a `.mcp.json` that automatically configures the Butterbase MCP server connection. All tools and the prompt are available immediately — no manual configuration needed.

### Always-On Context (CLAUDE.md)

The plugin provides Claude with always-on context about Butterbase:
- Environment variables (`BUTTERBASE_API_KEY`, `VITE_API_URL`, etc.)
- Core workflow (init → schema → RLS → auth → deploy)
- Important patterns (storage objectId, function Response objects, RLS roles)
- Documentation reference (all `butterbase_docs` topics)

### Skills and slash commands

39 guided skills and 34 slash commands. Skills load automatically when Claude sees a matching task; slash commands invoke them directly.

**Guided journey** — `/butterbase-skills:journey` takes an idea all the way to a deployed app: idea → plan → preflight → docs → schema → RLS → auth → storage → functions → realtime → durable objects → AI → RAG → agents → frontend → deploy smoke test, with optional substrate linking, template publishing, and hackathon submission. Each stage also has its own command (e.g. `/butterbase-skills:idea`, `/butterbase-skills:plan`, `/butterbase-skills:journey-schema`, `/butterbase-skills:submit`).

**Per-capability skills:**

| Skill | Slash command | Description |
|-------|--------------|-------------|
| Build App | `/butterbase-skills:build-app` | End-to-end guide: create app, design schema, set up RLS, configure auth, deploy functions, deploy frontend |
| Schema Design | `/butterbase-skills:schema` | Database schema DSL reference with column types, indexes, and data model patterns |
| Deploy Frontend | `/butterbase-skills:deploy` | Deployment workflow for React, Next.js, and static HTML frontends |
| Debug RLS | `/butterbase-skills:debug-rls` | Systematic Row-Level Security debugging with role simulation |
| Function Dev | `/butterbase-skills:function` | Serverless function development with handler signatures, triggers, and working examples |
| Auth Setup | `/butterbase-skills:auth` | OAuth providers, auth hooks, JWT lifetimes, service keys |
| Storage | `/butterbase-skills:storage` | Uploads, downloads, presigned URLs, storage ACLs |
| Realtime | `/butterbase-skills:realtime` | WebSocket subscriptions, presence, multiplayer state |
| Durable Objects | `/butterbase-skills:durable-objects` | Stateful per-key actors: chat rooms, rate limiters, long-running agents |
| AI | `/butterbase-skills:ai` | AI gateway: chat, embeddings, models, defaults, BYOK, usage |
| RAG | `/butterbase-skills:rag` | Knowledge bases, document ingestion, semantic search, Q&A |
| Integrations | `/butterbase-skills:integrations` | Third-party SaaS (email, SMS, Slack, calendar, CRM, …) via built-in integrations |
| Payments | `/butterbase-skills:payments` | Stripe Connect payments through `manage_billing` |
| Substrate | `/butterbase-skills:substrate` | Read/write the per-user agent-memory substrate |
| Migrations | `/butterbase-skills:migrations` | Move an app between regions, check, abort, or reverse a move |
| Contributing | `/butterbase-skills:contributing` | Contributor guide for the Butterbase monorepo |

Skills without a dedicated command: `agents` (declarative LLM/tool-graph agents), `meetings` (meeting bots and transcription), and `templates` (publish and clone public app templates).

## Alternative: CLI Setup

If you only need the MCP connection (without skills), use the CLI:

```bash
butterbase plugin setup
```

Or during project initialization:

```bash
butterbase init react-vite
```

Both generate a `.mcp.json` file that configures the MCP server connection.

## Local Development

When running the Butterbase monorepo locally, the MCP server URL defaults to `http://localhost:4000/mcp`. Set this in your environment:

```bash
export CONTROL_API_URL=http://localhost:4000
```

## Testing locally

Load the plugin from a local directory for development:

```bash
claude --plugin-dir /path/to/butterbase-plugin
```

## Source

- **GitHub**: [Butterbase Skills](https://github.com/butterbase-ai/butterbase-skills)
- **License**: MIT
