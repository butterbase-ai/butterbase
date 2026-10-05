---
title: MCP Setup
description: Connect your AI assistant to Butterbase through the Model Context Protocol.
---

Your AI assistant connects to Butterbase through MCP. That connection lets the assistant manage your entire backend — creating apps, evolving schemas, configuring authentication, managing storage, deploying functions, and more — using structured tools instead of manual work.

## What is MCP?

The **Model Context Protocol (MCP)** is a standard for connecting AI assistants to external tools and data sources. When you connect Butterbase via MCP, your assistant gains access to a broad set of tools and a quickstart prompt for managing your backend — creating apps, picking a region, evolving schemas, configuring auth, deploying functions, and more.

## Setting up the MCP connection

### Option 1: Claude Code Plugin (recommended)

Install Butterbase Skills for Claude Code. This auto-configures the MCP server and includes 6 guided skills:

```bash
# Add the marketplace
claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills

# Install the plugin
claude plugin install butterbase-skills@butterbase-skills
```

Set your API key:

```bash
export BUTTERBASE_API_KEY=bb_sk_your_key_here
```

The plugin includes:
- **Auto-configured MCP server** — nearly 40 tools and 1 prompt available immediately
- **39 skills and 34 slash commands** — including the guided `/butterbase-skills:journey` (idea → plan → build → deploy), plus `/butterbase-skills:build-app`, `/butterbase-skills:schema`, `/butterbase-skills:deploy`, `/butterbase-skills:debug-rls`, `/butterbase-skills:function`, and more
- **Always-on context** — environment variables, workflows, and patterns

### Option 2: CLI Setup

If you already have the Butterbase CLI installed:

```bash
butterbase plugin setup
```

This generates a `.mcp.json` in your project directory that configures the MCP connection.

### Option 3: Manual Configuration

Add this to your MCP configuration (`.mcp.json` or editor MCP settings):

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

This works with Claude Code, Cursor, Windsurf, and any MCP-compatible editor.

### MCP over HTTP

The MCP endpoint is available at:

| Method | Path | Purpose |
|--------|------|---------|
| GET, POST, DELETE | /mcp | Streamable HTTP MCP session |

Include your API key as a Bearer token in the Authorization header.

## Available tools

Butterbase exposes 38 tools. Most areas are consolidated into one `manage_*` tool that takes an `action` argument. See the [MCP Tools reference](/api-reference/mcp-tools) for every action and parameter.

### App Management

| Tool | What it does |
|------|--------------|
| **init_app** | Create a new backend app. You supply a name (and optionally a region); you receive the app id and API base URL. |
| **list_regions** | List the regions an app can be created or moved to. |
| **manage_app** (action: "list") | List all apps you have access to with their metadata. |
| **manage_app** (action: "delete") | Permanently delete an app and its database. This is irreversible. |
| **manage_app** (action: "get_config") | Read an app's current configuration (CORS origins, JWT settings, storage limits). |
| **manage_app** (action: "update_cors") | Set the list of allowed origins for browser requests to your app's API. |
| **manage_app** (actions: "pause", "update_access_mode", "secure", "set_visibility") | Pause or resume an app, switch between public and authenticated access, secure tables with user isolation, and publish an app as a template. |
| **manage_app** (actions: "get_env", "update_env") | Read and set app-level environment variables. |
| **manage_app** (actions: "find_templates", "clone", "get_clone_job", ...) | Find public templates and clone them, plus template release actions. |
| **manage_app** (actions: "move", "move_status", "teardown_source_replica") | Move an existing app to another region and track the migration. |
| **manage_migrations** | Inspect, abort, or reverse in-flight region migrations. |
| **manage_auth_config** (action: "update_jwt") | Configure access token lifetime and refresh token lifetime. |
| **manage_auth_config** (action: "generate_service_key") | Generate a `bb_sk_` prefixed API key for programmatic access. |
| **manage_auth_config** (action: "configure_auth_hook") | Set the function invoked after every successful auth event. |
| **manage_api_keys** | List or revoke API keys. |
| **manage_billing** | Check plan and usage, top up credits, and manage spending caps. |

### Schema & Migrations

| Tool | What it does |
|------|--------------|
| **manage_schema** (action: "get") | Read the current database schema for an app. |
| **manage_schema** (action: "apply") | Apply a declarative schema. |
| **manage_schema** (action: "dry_run") | Preview SQL statements without executing. |
| **manage_schema** (action: "list_migrations") | View the history of all schema migrations. |

### Data Operations

| Tool | What it does |
|------|--------------|
| **select_rows** | Query table rows with filtering, sorting, pagination. |
| **insert_row** | Insert a row into a table. |
| **seed_database** | Bulk-insert rows into tables in one call. |

### Authentication & Security

| Tool | What it does |
|------|--------------|
| **manage_oauth** (actions: "configure", "get", "update", "delete") | Register, list, modify, and remove social sign-in providers. |
| **manage_rls** (action: "enable") | Enable row-level security on a table. |
| **manage_rls** (action: "create_policy") | Create a custom RLS policy. |
| **manage_rls** (action: "create_user_isolation") | Quick user isolation setup. |
| **manage_rls** (actions: "list", "update_policy", "delete") | List, modify, and remove RLS policies. |
| **manage_auth_users** (actions: "list", "delete") | List or delete your app's end users. |
| **query_audit_logs** | Search authentication, admin, and function audit logs. |

### Storage

| Tool | What it does |
|------|--------------|
| **manage_storage** (action: "upload_url") | Get a presigned upload URL. |
| **manage_storage** (action: "download_url") | Get a presigned download URL. |
| **manage_storage** (action: "list") | List all files for an app. |
| **manage_storage** (action: "delete") | Delete a file from storage. |
| **manage_storage** (action: "update_config") | Toggle public read access and storage limits. |

### Serverless Functions and Durable Objects

| Tool | What it does |
|------|--------------|
| **deploy_function** | Deploy a TypeScript/JavaScript function. |
| **invoke_function** | Test-invoke a deployed function. |
| **manage_function** (actions: "list", "get", "delete") | List, inspect, and delete deployed functions. |
| **manage_function** (action: "update_env") | Update function environment variables. |
| **manage_function** (action: "get_logs") | View invocation logs. |
| **manage_function** (action: "update_settings") | Change per-function settings. |
| **manage_durable_objects** | Deploy and manage Durable Objects and their env vars. |
| **manage_kv** | Configure and read or write the app's KV store. |

### Frontend Deployment

| Tool | What it does |
|------|--------------|
| **create_frontend_deployment** | Create a deployment and get an upload URL. |
| **manage_frontend** (action: "start_deployment") | Start a deployment after uploading. |
| **manage_frontend** (action: "list_deployments") | View deployment history. |
| **manage_frontend** (action: "set_env") | Configure environment variables for builds. |
| **manage_frontend** (action: "configure_custom_domain") | Add, verify, or remove custom domains. |
| **manage_edge_ssr** | Deploy and list Edge SSR deployments. |
| **manage_preview** | Create and manage a preview copy of your app. |
| **promote_preview** | Check and push a preview's changes onto the live app. |
| **manage_repo** | Push, pull, and inspect your app's code snapshots. |

### Realtime, AI, and Integrations

| Tool | What it does |
|------|--------------|
| **manage_realtime** (actions: "configure", "get") | Enable realtime on tables and view the current configuration. |
| **manage_ai** | Chat, embeddings, video, image, and meeting-bot actions through the AI gateway. |
| **manage_agents** | Create and manage agent definitions. |
| **manage_rag_content** | Manage RAG collections and documents. |
| **rag_query** | Semantic search over a RAG collection. |
| **manage_integrations** | Enable third-party toolkits and execute their actions. |
| **manage_people** | Search and enrich people and company data. |

### Hackathon, Feedback & Documentation

| Tool | What it does |
|------|--------------|
| **list_partner_apis** | List partner APIs available to hackathon apps. |
| **prep_and_submit_hackathon_entry** | Prepare and submit a hackathon entry. |
| **submit_suggestion** | Submit feedback or bug reports. |
| **butterbase_docs** | Read the documentation by topic. |

## Generating an API key

You can generate API keys through the [dashboard](https://dashboard.butterbase.ai) on the API Keys page, or using the `manage_auth_config` MCP tool (action `generate_service_key`). Keys are prefixed with `bb_sk_` and provide full access to your apps and data.
