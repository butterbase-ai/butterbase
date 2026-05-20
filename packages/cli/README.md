# @butterbase/cli

Command-line tool for Butterbase project scaffolding and backend management.

## Installation

```bash
npm install -g @butterbase/cli
```

## Quick Start

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

## Commands

### Authentication

```bash
# Login
butterbase login

# Logout
butterbase logout
```

### Configuration

```bash
# Show current config
butterbase config get

# Set endpoint
butterbase config set endpoint https://api.butterbase.ai

# Set API key
butterbase config set apiKey bb_key_...
```

Configuration is stored in `~/.butterbase/config.json`.

### Apps

```bash
# List all apps
butterbase apps list

# Create new app
butterbase apps create my-app

# Set current app (used by other commands)
butterbase apps use app_abc123

# Delete app
butterbase apps delete app_abc123
```

### Schema

```bash
# Get current schema
butterbase schema get

# Save schema to file
butterbase schema get --output schema.json

# Preview schema changes (dry-run)
butterbase schema apply schema.json --dry-run

# Apply schema changes
butterbase schema apply schema.json

# Apply with custom migration name
butterbase schema apply schema.json --name "add_users_table"

# Use specific app
butterbase schema get --app app_abc123
```

### Functions

```bash
# List deployed functions
butterbase functions list

# Deploy function
butterbase functions deploy ./functions/hello.ts

# Deploy with custom name
butterbase functions deploy ./functions/hello.ts --name my-function

# Deploy with description
butterbase functions deploy ./functions/hello.ts --description "Hello world function"

# Deploy cron function
butterbase functions deploy ./functions/cleanup.ts --trigger cron

# View function logs
butterbase functions logs my-function

# View error logs only
butterbase functions logs my-function --level error

# Limit number of logs
butterbase functions logs my-function --limit 50
```

### Storage

```bash
# List storage objects
butterbase storage list

# Upload file
butterbase storage upload ./image.png

# Delete object
butterbase storage delete obj_abc123
```

### AI

```bash
butterbase ai chat "Summarize this" --model openai/gpt-4o-mini
butterbase ai chat "Explain RAG" --system "You're a concise teacher." --temperature 0.2
butterbase ai embed "hello world" "another doc"
butterbase ai models
butterbase ai config get
butterbase ai config set --default-model openai/gpt-4o-mini --max-tokens-per-request 4000
butterbase ai config set --byok-key sk-or-...           # rotate BYOK key; "" to clear
butterbase ai usage --start-date 2026-05-01 --end-date 2026-05-31
```

### OAuth (admin)

```bash
butterbase oauth configure google \
  --client-id ... --client-secret ... \
  --redirect-uri https://app.example/cb \
  --scope openid --scope email
butterbase oauth list
butterbase oauth get google
butterbase oauth update google --enabled false
butterbase oauth delete google
```

### Audit logs

```bash
butterbase audit query --category auth --event-type login --limit 50
butterbase audit query --from 2026-05-01 --to 2026-05-31 --action create --resource-type user
butterbase audit query --actor-id user_123 --json
```

### App config (server-side)

```bash
butterbase apps config get
butterbase apps config cors --allowed-origin https://app.example --allow-credentials true
butterbase apps config jwt --access-token-ttl 15m --refresh-token-ttl-days 30
butterbase apps config storage --public-read true --max-file-size-mb 25 --allowed-content-type image/png --allowed-content-type image/jpeg
butterbase apps config access-mode authenticated
butterbase apps config secure --table posts --table comments --user-column author_id --access-mode authenticated
```

### Regions + multi-region moves

```bash
butterbase regions list
butterbase apps move app_abc us-west-2 --follow
butterbase apps migrations active                 # current app
butterbase apps migrations status app_abc m_xyz
butterbase apps migrations abort app_abc m_xyz     # before cutover
butterbase apps migrations reverse app_abc m_xyz   # after cutover
butterbase apps replicas list
butterbase apps replicas teardown m_xyz
```

### App-level billing (Stripe Connect)

```bash
butterbase app-billing plans list
butterbase app-billing plans create --name pro --price-cents 1999 --interval month
butterbase app-billing plans update plan_abc --price-cents 2499
butterbase app-billing products list
butterbase app-billing products create --name "Lifetime access" --price-cents 9900
butterbase app-billing subscribe plan_abc
butterbase app-billing subscription
butterbase app-billing cancel
butterbase app-billing purchase prod_xyz
butterbase app-billing orders list
butterbase app-billing orders get order_abc
```

### Scoped API keys + integrations

```bash
butterbase keys generate ci-key --scope schema:read --scope functions:invoke
butterbase integrations configure github --scope repo --scope read:user
butterbase integrations connect github --redirect-url https://app.example/cb --scope repo
```

### Functions deploy (full options)

```bash
butterbase functions deploy fn.ts \
  --name my-fn \
  --trigger cron --trigger-config '{"schedule":"*/5 * * * *"}' \
  --env API_KEY=sk_... --env DEBUG=true \
  --timeout-ms 9000 --memory-mb 256
```

### RLS

```bash
butterbase rls create --table posts --policy-name posts_own \
  --command SELECT --using "author_id = auth.uid()" \
  --role user --restrictive
butterbase rls delete posts                 # delete all policies on table
butterbase rls delete posts --policy posts_own
```

## Global Options

Most commands support the `--app` flag to specify an app ID:

```bash
butterbase schema get --app app_abc123
butterbase functions list --app app_abc123
butterbase storage list --app app_abc123
```

If `--app` is not provided, the CLI uses the current app set with `butterbase apps use`.

## Configuration

The CLI stores configuration in two places:

1. **Global config**: `~/.butterbase/config.json`
   - API key
   - Default endpoint
   - Current app

2. **Project config**: `.butterbase/config.json` (in project directory)
   - App ID
   - Endpoint override

Project config takes precedence over global config.

## Environment Variables

You can also configure the CLI using environment variables:

- `BUTTERBASE_API_KEY` - API key
- `BUTTERBASE_ENDPOINT` - API endpoint URL

## Examples

### Complete Workflow

```bash
# 1. Login
butterbase login

# 2. Create app
butterbase apps create my-grocery-app

# 3. Set as current
butterbase apps use app_abc123

# 4. Create schema file
cat > schema.json <<EOF
{
  "tables": {
    "grocery_items": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "name": { "type": "text" },
        "quantity": { "type": "integer", "default": "1" },
        "purchased": { "type": "boolean", "default": "false" },
        "user_id": { "type": "uuid" },
        "created_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
EOF

# 5. Apply schema
butterbase schema apply schema.json

# 6. Deploy function
butterbase functions deploy ./functions/add-item.ts

# 7. Upload image
butterbase storage upload ./logo.png
```

### Working with Multiple Apps

```bash
# Create production app
butterbase apps create my-app-prod
# Returns: app_prod123

# Create staging app
butterbase apps create my-app-staging
# Returns: app_staging456

# Deploy to production
butterbase functions deploy ./functions/api.ts --app app_prod123

# Deploy to staging
butterbase functions deploy ./functions/api.ts --app app_staging456

# Switch between apps
butterbase apps use app_prod123
butterbase apps use app_staging456
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test locally
node dist/bin/butterbase.js --help
```

### Integrations

```bash
# List available integrations (curated)
butterbase integrations list --app app_abc123

# Search the full catalog
butterbase integrations list --search salesforce --app app_abc123

# Show configured integrations
butterbase integrations config --app app_abc123

# Enable a toolkit
butterbase integrations configure gmail --app app_abc123

# Disable a toolkit
butterbase integrations disable gmail --app app_abc123

# Generate OAuth URL for an end-user
butterbase integrations connect gmail --redirect-url https://yourapp.com/settings --app app_abc123

# List connected accounts
butterbase integrations connections --app app_abc123

# Disconnect an account
butterbase integrations disconnect <connection-id> --app app_abc123

# List tools for a toolkit
butterbase integrations tools gmail --app app_abc123

# Execute a tool
butterbase integrations execute GMAIL_SEND_EMAIL --data '{"to":"x@y.com","subject":"Hi","body":"Hello"}' --app app_abc123
```

## Error output

The CLI throws typed `ButterbaseError`s from `@butterbase/sdk`. The top-level
handler renders the class name, message, and the structured fields the backend
returned (`code`, `status`, `remediation`). Example for an unauthenticated call:

```
AuthError: Invalid API key
  code:        AUTH_INVALID_API_KEY
  status:      401
  remediation: Rotate the key with `butterbase keys generate` and update ~/.butterbase/config.json.
```

The error codes come from `@butterbase/shared`'s `ErrorCodes` namespace — see
the SDK README for the full list.

## License

MIT
