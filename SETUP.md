# Butterbase Setup Guide

## Quick Start

### 1. Run Database Migrations

```bash
cd db/control-plane
npm install
npm run migrate
```

This creates:
- `platform_users` table
- `apps` table  
- `api_keys` table (NEW)

### 2. Start Services

```bash
# From project root
docker compose up
```

Services will be available at:
- **Dashboard**: http://localhost:3000
- **Control API**: http://localhost:4000
- **Control DB**: localhost:5433
- **Data Plane DB**: localhost:5435
- **PgBouncer**: localhost:6432

### 3. Test Without Auth (Development Mode)

The Control API starts with `AUTH_ENABLED=false` by default, allowing you to test without Cognito:

```bash
# Create an app
curl -X POST http://localhost:4000/init \
  -H "Content-Type: application/json" \
  -d '{"name": "test-app"}'

# List apps
curl http://localhost:4000/apps
```

### 4. Enable Authentication

#### Option A: API Keys (for MCP/CLI)

1. Create a test user:
```sql
INSERT INTO platform_users (email, cognito_sub)
VALUES ('dev@butterbase.local', 'dev-user-123');
```

2. Generate an API key:
```bash
curl -X POST http://localhost:4000/dashboard/api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt-token>" \
  -d '{"name": "test-key"}'
```

3. Use the API key:
```bash
export BUTTERBASE_API_KEY="bb_sk_..."
curl http://localhost:4000/apps \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
```

4. Configure Cursor for hosted MCP over HTTP:
```json
{
  "mcpServers": {
    "butterbase": {
      "url": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer ${env:BUTTERBASE_MCP_TOKEN}"
      }
    }
  }
}
```

Then set:
```bash
export BUTTERBASE_MCP_TOKEN="bb_sk_..."
```

The existing stdio mode still works for local contributors:
```json
{
  "mcpServers": {
    "butterbase": {
      "command": "node",
      "args": ["./services/mcp-server/dist/index.js"]
    }
  }
}
```

#### Option B: Cognito (for Dashboard)

1. Create a Cognito User Pool in AWS Console

2. Create an App Client:
   - Type: Single-page application (SPA)
   - Name: `butterbase-dashboard`
   - Auth flows: Authorization code grant with PKCE
   - Callback URLs: `http://localhost:3000/auth/callback`
   - Logout URLs: `http://localhost:3000`
   - Scopes: `openid`, `email`, `profile`

3. Update `.env` in `services/dashboard`:
```bash
NEXT_PUBLIC_COGNITO_USER_POOL_ID=us-east-1_xxxxx
NEXT_PUBLIC_COGNITO_CLIENT_ID=xxxxx
NEXT_PUBLIC_COGNITO_DOMAIN=your-domain.auth.us-east-1.amazoncognito.com
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_CONTROL_API_URL=http://localhost:4000
```

4. Enable auth in Control API:
```yaml
# docker-compose.yml
control-api:
  environment:
    AUTH_ENABLED: "true"
    COGNITO_USER_POOL_ID: ${COGNITO_USER_POOL_ID}
    COGNITO_CLIENT_ID: ${COGNITO_CLIENT_ID}
    COGNITO_REGION: us-east-1
```

5. Restart services:
```bash
docker compose down
docker compose up
```

### 5. Access Dashboard

1. Navigate to http://localhost:3000
2. Click "INITIATE_AUTH_SEQUENCE"
3. Sign up/login with Cognito
4. You'll be redirected to the dashboard

## Development Workflow

### Backend Development

```bash
cd services/control-api
npm run dev  # Watch mode with tsx
```

### Frontend Development

```bash
cd services/dashboard
npm install
npm run dev  # Next.js dev server
```

### Run Tests

```bash
# Control API tests
cd services/control-api
npm test

# MCP Server tests
cd services/mcp-server
npm test
```

## Troubleshooting

### "The dependency 'database' of plugin 'auth' is not registered"

This has been fixed. Make sure you rebuild:
```bash
cd services/control-api
npm run build
```

### "Invalid JWT token"

- Check that Cognito credentials are correct in `.env`
- Verify the user pool and client ID match
- Ensure callback URLs are configured in Cognito

### "Invalid or revoked API key"

- API keys are hashed with SHA-256
- Keys are shown only once when generated
- Check that the key hasn't been revoked

### "permission denied for schema public" (Neon)

This happens when running migrations against Neon-hosted app databases. Two common causes:

1. **Pooler endpoint remaps the role**: The stored connection string uses the Neon pooler (`-pooler` in hostname), which remaps `neondb_owner` to a lower-privilege role like `butterbase_service`. Use the direct endpoint instead — the backfill script handles this automatically.

2. **PG 15+ default schema permissions**: PostgreSQL 15+ revokes `CREATE` on `public` from non-owner roles. During provisioning, the platform grants `ALL ON SCHEMA public` to the app role via `neondb_owner`. If this step was missed, connect as `neondb_owner` via the direct endpoint and run:
   ```sql
   GRANT ALL ON SCHEMA public TO butterbase;
   ```

To backfill migrations on existing apps:
```bash
CONTROL_DB_URL=postgresql://... npx tsx scripts/backfill-migrations.ts app_abc123
```

### Database Connection Issues

```bash
# Check if databases are running
docker compose ps

# View logs
docker compose logs control-plane-db
docker compose logs data-plane-db

# Reset databases
docker compose down -v
docker compose up
```

## Architecture

```
┌─────────────┐
│  Dashboard  │ :3000
│  (Next.js)  │
└──────┬──────┘
       │ HTTP + JWT
       ▼
┌─────────────┐
│ Control API │ :4000
│  (Fastify)  │
└──────┬──────┘
       │
       ├─────► Control DB :5433 (platform_users, apps, api_keys)
       │
       └─────► Data Plane DB :5435 (app databases)
```

## Next Steps

1. ✅ Backend authentication working
2. ✅ Dashboard UI complete
3. 🔄 Configure Cognito for production
4. 🔄 Deploy to AWS/Vercel
5. 🔄 Add MCP server authentication
6. 🔄 Build CLI tool

## Support

For issues or questions:
- Check logs: `docker compose logs -f`
- Review tests: `npm test`
- See README files in each service directory

## Workers for Platforms

Environment variables for the Workers for Platforms (WfP) frontend deployment backend:

- `CLOUDFLARE_DISPATCH_NAMESPACE` — name of the WfP dispatch namespace that holds customer frontend workers (default: `bb-frontends`).
- `CLOUDFLARE_SUBDOMAIN_KV_ID` — Workers KV namespace ID used by the dispatch worker to resolve `{sub}.butterbase.dev` → app_id.
- `CLOUDFLARE_DISPATCH_WORKER_NAME` — name of the dispatch worker deployed in front of the namespace (default: `bb-dispatch`).
- `DEPLOYMENT_DEFAULT_BACKEND` — default backend for new apps: `pages` or `wfp` (default: `pages`).
