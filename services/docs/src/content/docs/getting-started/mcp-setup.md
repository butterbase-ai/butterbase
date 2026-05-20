---
title: MCP Setup
description: Connect your AI assistant to Butterbase through the Model Context Protocol.
---

Your AI assistant connects to Butterbase through MCP. That connection lets the assistant manage your entire backend — creating apps, evolving schemas, configuring authentication, managing storage, deploying functions, and more — using structured tools instead of manual work.

## What is MCP?

The **Model Context Protocol (MCP)** is a standard for connecting AI assistants to external tools and data sources. When you connect Butterbase via MCP, your assistant gains access to a broad set of tools and a quickstart prompt for managing your backend — creating apps, picking a region, evolving schemas, configuring auth, deploying functions, and more.

## Setting up the MCP connection

### Option 1: Claude Code Plugin (recommended)

Install the Butterbase plugin for Claude Code. This auto-configures the MCP server and includes 6 guided skills:

```bash
# Add the marketplace
claude plugin marketplace add https://github.com/NetGPT-Inc/butterbase-plugin

# Install the plugin
claude plugin install butterbase
```

Set your API key:

```bash
export BUTTERBASE_API_KEY=bb_sk_your_key_here
```

The plugin includes:
- **Auto-configured MCP server** — 43 tools and 1 prompt available immediately
- **6 skills** — `/butterbase:build-app`, `/butterbase:schema`, `/butterbase:deploy`, `/butterbase:debug-rls`, `/butterbase:function`, `/butterbase:contributing`
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

### App Management

| Tool | What it does |
|------|--------------|
| **init_app** | Create a new backend app. You supply a name (and optionally a region); you receive the app id and API base URL. |
| **list_regions** | List the regions an app can be created or moved to. |
| **move_app** | Move an existing app to another region. |
| **move_app_status** | Check the progress of a move in flight. |
| **list_apps** | List all apps you have access to with their metadata. |
| **delete_app** | Permanently delete an app and its database. This is irreversible. |
| **get_app_config** | Read an app's current configuration (CORS origins, JWT settings, storage limits). |
| **update_cors** | Set the list of allowed origins for browser requests to your app's API. |
| **update_jwt_config** | Configure access token lifetime and refresh token lifetime. |
| **generate_service_key** | Generate a `bb_sk_` prefixed API key for programmatic access. |

### Schema & Migrations

| Tool | What it does |
|------|--------------|
| **get_schema** | Read the current database schema for an app. |
| **apply_schema** | Apply a declarative schema. Set `dry_run: true` to preview. |
| **dry_run_schema** | Preview SQL statements without executing. |
| **list_migrations** | View the history of all schema migrations. |

### Data Operations

| Tool | What it does |
|------|--------------|
| **select_rows** | Query table rows with filtering, sorting, pagination. |
| **insert_row** | Insert a row into a table. |

### Authentication & Security

| Tool | What it does |
|------|--------------|
| **configure_oauth_provider** | Register a social sign-in provider. |
| **get_oauth_config** | List all configured OAuth providers. |
| **update_oauth_provider** | Modify an existing OAuth provider. |
| **delete_oauth_provider** | Remove an OAuth provider. |
| **enable_rls** | Enable row-level security on a table. |
| **create_policy** | Create a custom RLS policy. |
| **create_user_isolation_policy** | Quick user isolation setup. |
| **get_rls_policies** | List active RLS policies. |
| **delete_rls_policy** | Remove RLS from a table. |
| **query_audit_logs** | Search authentication audit logs. |

### Storage

| Tool | What it does |
|------|--------------|
| **generate_upload_url** | Get a presigned upload URL. |
| **generate_download_url** | Get a presigned download URL. |
| **get_storage_objects** | List all files for an app. |
| **delete_storage_object** | Delete a file from storage. |

### Serverless Functions

| Tool | What it does |
|------|--------------|
| **deploy_function** | Deploy a TypeScript/JavaScript function. |
| **list_functions** | List all deployed functions. |
| **invoke_function** | Test-invoke a deployed function. |
| **delete_function** | Delete a deployed function. |
| **update_function_env** | Update environment variables. |
| **get_function_logs** | View invocation logs. |

### Frontend Deployment

| Tool | What it does |
|------|--------------|
| **create_frontend_deployment** | Create a deployment and get an upload URL. |
| **start_frontend_deployment** | Start a deployment after uploading. |
| **list_frontend_deployments** | View deployment history. |
| **set_frontend_env** | Configure environment variables for builds. |

### Realtime

| Tool | What it does |
|------|--------------|
| **configure_realtime** | Enable realtime on tables. |
| **get_realtime_config** | View current realtime configuration. |

### Feedback & Documentation

| Tool | What it does |
|------|--------------|
| **submit_suggestion** | Submit feedback or bug reports. |
| **butterbase_docs** | Read the documentation by topic. |

## Generating an API key

You can generate API keys through the [dashboard](https://dashboard.butterbase.ai) on the API Keys page, or using the `generate_service_key` MCP tool. Keys are prefixed with `bb_sk_` and provide full access to your apps and data.
