---
title: Claude Code Plugin
description: Claude Code plugin with guided skills for building, deploying, and debugging Butterbase apps.
---

The `@butterbase/skills` is a Claude Code plugin that auto-configures the Butterbase MCP server and provides guided skills for common workflows.

## Installation

```bash
# Add the Butterbase marketplace
claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills

# Install the plugin
claude plugin install butterbase
```

Set your API key:

```bash
export BUTTERBASE_API_KEY=bb_sk_your_key_here
```

## What's included

### MCP Server Auto-Configuration

The plugin includes a `.mcp.json` that automatically configures the Butterbase MCP server connection. All 43 tools and 1 prompt are available immediately — no manual configuration needed.

### Always-On Context (CLAUDE.md)

The plugin provides Claude with always-on context about Butterbase:
- Environment variables (`BUTTERBASE_API_KEY`, `VITE_API_URL`, etc.)
- Core workflow (init → schema → RLS → auth → deploy)
- Important patterns (storage objectId, function Response objects, RLS roles)
- Documentation reference (all `butterbase_docs` topics)

### Skills

6 guided skills for common Butterbase workflows:

| Skill | Slash command | Description |
|-------|--------------|-------------|
| Build App | `/butterbase-skills:build-app` | End-to-end guide: create app, design schema, set up RLS, configure auth, deploy functions, deploy frontend |
| Schema Design | `/butterbase-skills:schema` | Database schema DSL reference with column types, indexes, and 4 complete data model patterns |
| Deploy Frontend | `/butterbase-skills:deploy` | 7-step deployment workflow for React, Next.js, and static HTML frontends |
| Debug RLS | `/butterbase-skills:debug-rls` | Systematic Row-Level Security debugging with role simulation |
| Function Dev | `/butterbase-skills:function` | Serverless function development with handler signatures, triggers, and working examples |
| Contributing | `/butterbase-skills:contributing` | Contributor guide for the Butterbase monorepo |

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

- **GitHub**: [github.com/butterbase-ai/butterbase-skills](https://github.com/butterbase-ai/butterbase-skills)
- **License**: MIT
