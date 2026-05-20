# @butterbase/plugin

Claude Code plugin for [Butterbase](https://butterbase.ai) — the AI-Native Backend-as-a-Service.

This plugin gives Claude deep knowledge of Butterbase's 42+ MCP tools, guides you through common workflows, and auto-configures the MCP server connection.

## Installation

```bash
claude plugin add @butterbase/plugin
```

## Setup

1. **Get an API key** — Sign up at [butterbase.ai](https://butterbase.ai) or generate one with the CLI:
   ```bash
   butterbase keys generate
   ```

2. **Set the environment variable:**
   ```bash
   export BUTTERBASE_API_KEY=bb_sk_your_key_here
   ```

3. **Start Claude Code** — The plugin auto-configures the Butterbase MCP server connection. All 42+ tools are available immediately.

## Available Skills

| Skill | Description | Example prompts |
|-------|-------------|-----------------|
| `butterbase:build-app` | Build a complete app from scratch | "Build me a blog with auth and comments" |
| `butterbase:schema-design` | Design database schemas | "Design a schema for an e-commerce app" |
| `butterbase:deploy-frontend` | Deploy frontends to live URLs | "Deploy my React app to production" |
| `butterbase:debug-rls` | Debug Row-Level Security | "Users are seeing each other's data" |
| `butterbase:function-dev` | Develop serverless functions | "Create a cron job to clean up expired sessions" |
| `butterbase:contributing` | Contribute to Butterbase | "How do I add a new MCP tool?" |

## What's Included

- **`.mcp.json`** — Auto-configures the Butterbase MCP server connection (HTTPS endpoint)
- **`CLAUDE.md`** — Always-on context: environment variables, workflows, patterns, documentation references
- **6 skills** — Guided workflows for building, deploying, debugging, and contributing

## Local Development

If you're running the Butterbase monorepo locally, the MCP server URL defaults to `http://localhost:4000/mcp`. Set this in your environment:

```bash
export CONTROL_API_URL=http://localhost:4000
```

## Also Available

- **[@butterbase/sdk](https://www.npmjs.com/package/@butterbase/sdk)** — TypeScript SDK for client-side and server-side use
- **[@butterbase/cli](https://www.npmjs.com/package/@butterbase/cli)** — CLI tool for project scaffolding and backend management
- **`butterbase_docs` MCP tool** — Call with any topic (auth, storage, functions, etc.) for comprehensive reference docs

## License

MIT
