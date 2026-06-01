# @butterbase/mcp

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [Butterbase](https://butterbase.ai) — manage schemas, auth, functions, storage, RAG, realtime, and deploys on Butterbase from any MCP-capable client (Claude Code, Claude Desktop, Cursor, Windsurf, etc.).

## Install

```bash
npx @butterbase/mcp
```

Or install globally:

```bash
npm install -g @butterbase/mcp
butterbase-mcp
```

## Configure

Add to your MCP client config (`.mcp.json`, `claude_desktop_config.json`, etc.):

```json
{
  "mcpServers": {
    "butterbase": {
      "command": "npx",
      "args": ["-y", "@butterbase/mcp"],
      "env": {
        "BUTTERBASE_API_KEY": "bb_sk_your_key_here"
      }
    }
  }
}
```

Get an API key at [butterbase.ai](https://butterbase.ai).

## Hosted alternative

Prefer to skip the local install? Butterbase also runs a hosted MCP endpoint:

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

## What you can do

The server exposes tools across Butterbase's surface area, including:

- **Apps & regions** — `init_app`, `manage_app`, `list_regions`, `move_app`
- **Schema** — `manage_schema`, `manage_migrations`
- **Auth** — `manage_auth_config`, `manage_auth_users`, `manage_oauth`
- **Data** — `select_rows`, `insert_row`, `seed_database`
- **Functions** — `deploy_function`, `invoke_function`, `manage_function`
- **Storage** — `manage_storage`
- **Frontends** — `create_frontend_deployment`, `manage_frontend`, `manage_edge_ssr`
- **RAG** — `manage_rag_content`, `rag_query`
- **Realtime & Durable Objects** — `manage_realtime`, `manage_durable_objects`
- **AI gateway** — `manage_ai`
- **RLS** — `manage_rls`
- **Integrations, billing, KV, API keys, audit logs**, and more

See the [Butterbase docs](https://butterbase.ai/docs) for the full list.

## License

Apache-2.0 © NetGPT Inc.
