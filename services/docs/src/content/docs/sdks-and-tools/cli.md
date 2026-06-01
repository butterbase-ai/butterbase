---
title: CLI
description: Command-line tool for Butterbase project scaffolding and backend management.
---

The `@butterbase/cli` provides a command-line interface for managing your Butterbase apps, schemas, functions, storage, and deployments.

## Installation

```bash
npm install -g @butterbase/cli
```

## Quick start

```bash
# Login with your API key
butterbase login

# Create a new app
butterbase apps create my-app

# Set as current app
butterbase apps use app_abc123

# Get current schema
butterbase schema get --output schema.json

# Apply schema changes
butterbase schema apply schema.json

# Deploy a function
butterbase functions deploy ./functions/hello.ts

# Upload a file
butterbase storage upload ./image.png
```

## Project init

```bash
# Scaffold a new project (prompts for name, template, optional app ID)
butterbase init

# Specify the template directly
butterbase init react-vite
```

The current supported template is `react-vite`. The command writes the project, copies a `.env` if a template `.env.example` exists, and prints follow-up steps (`cd`, `npm install`, `npm run dev`) plus MCP / agent setup instructions.

## Authentication

```bash
butterbase login
butterbase logout
```

## Configuration

```bash
# Show current config
butterbase config get

# Set endpoint
butterbase config set endpoint https://api.butterbase.ai

# Set API key
butterbase config set apiKey bb_sk_...
```

Configuration is stored in `~/.butterbase/config.json`. Project-level config in `.butterbase/config.json` takes precedence.

## Apps

```bash
butterbase apps list
butterbase apps create my-app
butterbase apps use app_abc123
butterbase apps delete app_abc123
```

Region selection at app creation and app moves are currently available via [MCP](/getting-started/mcp-setup/) tools (`init_app`, `list_regions`, `move_app`, `move_app_status`) and the [REST API](/api-reference/platform-api/#apps--regions). See [Regions](/core-concepts/regions/) for guidance.

## Schema

```bash
# Get current schema
butterbase schema get

# Save to file
butterbase schema get --output schema.json

# Preview changes (dry-run)
butterbase schema apply schema.json --dry-run

# Apply changes
butterbase schema apply schema.json

# Apply with custom migration name
butterbase schema apply schema.json --name "add_users_table"

# Use specific app
butterbase schema get --app app_abc123
```

## Functions

```bash
# List deployed functions
butterbase functions list

# Deploy function
butterbase functions deploy ./functions/hello.ts

# Deploy with custom name
butterbase functions deploy ./functions/hello.ts --name my-function

# Deploy cron function
butterbase functions deploy ./functions/cleanup.ts --trigger cron

# View logs
butterbase functions logs my-function

# Error logs only
butterbase functions logs my-function --level error

# Limit log count
butterbase functions logs my-function --limit 50
```

Log output shows timestamp, method, status code, duration, and errors for each invocation. If the function used `console.log/info/warn/error/debug`, the captured output appears indented under each log entry.

## Storage

```bash
butterbase storage list
butterbase storage upload ./image.png
butterbase storage delete obj_abc123
```

## Realtime

```bash
# Enable realtime broadcasts on one or more tables
butterbase realtime enable posts comments

# Show realtime configuration (URL, active connection, table list)
butterbase realtime config
butterbase realtime config --json

# Disable realtime on a single table
butterbase realtime disable posts
```

## Frontend env vars

These environment variables are baked into your frontend build, not your functions. For function env vars, see the Functions section above and the [functions concept page](/core-concepts/functions).

```bash
# Set one or more KEY=VALUE pairs
butterbase env set VITE_API_URL=https://api.example.com DEBUG=true

# List current keys (values are not shown)
butterbase env list
butterbase env list --json

# Load from a .env file
butterbase env set-file .env.production
```

## API keys

```bash
# Generate a new key (shown once)
butterbase keys generate "deploy-bot"

# List keys (key prefix only — full values are not retrievable)
butterbase keys list

# Revoke a key (prompts for confirmation)
butterbase keys revoke key_abc123
```

## Integrations

Manage third-party tool integrations (Gmail, Slack, GitHub, etc.). See the [integrations concept page](/core-concepts/integrations) for the higher-level model.

```bash
# List the curated catalog (or search the full catalog)
butterbase integrations list
butterbase integrations list --search salesforce

# Show toolkits configured for the current app
butterbase integrations config

# Enable a toolkit for the app
butterbase integrations configure gmail
butterbase integrations configure slack --display-name "Workspace bot"

# Disable a toolkit
butterbase integrations disable slack

# Generate an OAuth URL for an end-user to connect their account
butterbase integrations connect gmail \
  --redirect-url https://app.example.com/integrations/callback

# List all end-user connections
butterbase integrations connections

# Disconnect a single user's account
butterbase integrations disconnect ca_xxx

# List tools available for a connected toolkit
butterbase integrations tools gmail

# Execute a tool (e.g., as a smoke test)
butterbase integrations execute GMAIL_SEND_EMAIL \
  --data '{"to":"user@example.com","subject":"hi","body":"hello"}'
```

Most subcommands accept `--app <app-id>` to target a specific app and `--user-id <uuid>` when calling on behalf of a specific end-user.

## Custom domains

Manage custom hostnames for frontend deployments. Requires Pro plan or above. See the [custom domains setup guide](/core-concepts/frontend-deployment#custom-domains).

```bash
# List domains for the current app
butterbase domains list

# Add a new custom hostname (returns the CNAME target + setup instructions)
butterbase domains add app.example.com

# Poll verification status
butterbase domains status dom_abc123

# Re-trigger verification after fixing DNS
butterbase domains verify dom_abc123

# Remove a domain (prompts; pass --yes to skip)
butterbase domains delete dom_abc123 --yes
```

## Plugin

```bash
# Set up Claude Code / MCP integration for this project
butterbase plugin setup
```

This generates a `.mcp.json` file in your current directory that configures the Butterbase MCP server connection. If `.mcp.json` already exists, the command skips to avoid overwriting.

For the full plugin with guided skills, install separately:

```bash
claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills
claude plugin install butterbase
```

## Data

```bash
butterbase data list             # List tables
butterbase data query posts      # Query rows from a table
```

## Deployments

```bash
butterbase deploy ./dist         # Deploy frontend from a directory
```

## Project status

```bash
# Print app summary: name, region, tables, deployments, env keys, functions, CORS
butterbase status
butterbase status --json
```

## Open in browser

```bash
# Open the live frontend URL
butterbase open

# Open the API base URL instead
butterbase open --api
```

If no active deployment exists, `butterbase open` exits with an error.

## Global options

Most commands support `--app` to target a specific app:

```bash
butterbase schema get --app app_abc123
butterbase functions list --app app_abc123
butterbase storage list --app app_abc123
```

If `--app` is not provided, the CLI uses the current app set with `butterbase apps use`.

## KV

```bash
# Get a value
butterbase kv get mykey

# Set a value with optional TTL
butterbase kv set mykey '{"a":1}' --ttl 3600

# Delete a key
butterbase kv del mykey

# List keys by prefix
butterbase kv ls --prefix user: --limit 50

# Show KV store statistics
butterbase kv stats

# Flush all keys (requires confirmation)
butterbase kv flush --confirm

# List all exposure rules
butterbase kv rules

# Expose a key pattern with role-based access
butterbase kv expose "user:*" --read authed --write owner

# Unexpose a key pattern
butterbase kv unexpose "user:*"

# Apply exposure rules from a config file
butterbase kv apply ./kv.config.ts --dry-run
```

### Common KV workflows

**Deploy expose rules from a config file:**

```bash
# kv.config.ts in your project root, then:
butterbase kv apply kv.config.ts
```

The config declares which key patterns are reachable from frontend code. The CLI diffs against the live rules and applies only the deltas — safe to re-run.

**Browse keys in production:**

```bash
butterbase kv ls --prefix session:
# 142 keys under session:*

butterbase kv stats
# {
#   "keys_total": 1284,
#   "bytes_used": 2202112,
#   "max_keys": 100000,
#   "max_storage_bytes": 104857600,
#   "max_ops_per_sec": 500,
#   "max_value_bytes": 65536
# }
```

**Read/write a single key during an incident:**

```bash
butterbase kv get rate-limit:user_42        # peek a counter
butterbase kv set feature:new-checkout off  # flip a flag without redeploying
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `BUTTERBASE_API_KEY` | API key |
| `BUTTERBASE_ENDPOINT` | API endpoint URL |
