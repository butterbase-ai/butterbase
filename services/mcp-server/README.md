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

The server exposes 38 tools across Butterbase's surface area, including:

- **Apps & regions** — `init_app`, `manage_app` (actions: list/delete/pause/get_config/update_access_mode/secure/update_cors/set_visibility/preview_clone_env_vars/clone/get_clone_job/find_templates/set_clone_webhook/link_substrate/unlink_substrate/set_substrate_autopropagate/move/move_status/teardown_source_replica/get_env/update_env/publish_template_release/list_template_releases/get_template_release/check_template_updates/update_from_template), `list_regions`
- **Schema** — `manage_schema`, `manage_migrations`
- **Auth** — `manage_auth_config`, `manage_auth_users`, `manage_oauth`, `manage_people`
- **Data** — `select_rows`, `insert_row`, `seed_database`
- **Functions** — `deploy_function`, `invoke_function`, `manage_function`
- **Storage & KV** — `manage_storage`, `manage_kv`
- **Frontends & previews** — `create_frontend_deployment`, `manage_frontend`, `manage_edge_ssr`, `manage_preview`, `promote_preview`
- **RAG** — `manage_rag_content`, `rag_query`
- **Realtime & Durable Objects** — `manage_realtime`, `manage_durable_objects`
- **AI gateway & agents** — `manage_ai`, `manage_agents`
- **RLS** — `manage_rls`
- **Repo** — `manage_repo`
- **Integrations & billing** — `manage_integrations`, `list_partner_apis`, `manage_billing`
- **API keys & audit logs** — `manage_api_keys`, `query_audit_logs`
- **Docs, suggestions & hackathons** — `butterbase_docs`, `submit_suggestion`, `prep_and_submit_hackathon_entry`

See the [Butterbase docs](https://butterbase.ai/docs) for the full list.

## License

Apache-2.0 © NetGPT Inc.
