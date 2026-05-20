# Subdomain Implementation Guide

**Platform Domain:** butterbase.ai
**User Apps Domain:** butterbase.dev

---

## Domain Strategy

### butterbase.ai (Platform)
- Marketing website
- Platform API
- Dashboard
- Documentation
- Status page

### butterbase.dev (User Apps Only)
- All user-created apps
- Clean separation from platform
- Professional appearance

---

## URL Structure

### Platform URLs (butterbase.ai)

| Service | URL | Purpose |
|---------|-----|---------|
| Website | `butterbase.ai` | Marketing/landing page |
| Platform API | `api.butterbase.ai` | Platform management API |
| Dashboard | `dashboard.butterbase.ai` | Web management UI |
| Documentation | `docs.butterbase.ai` | API documentation |
| Status Page | `status.butterbase.ai` | Uptime status |

### User App URLs (butterbase.dev)

**Primary (Friendly Name):**
```
{app-name}.butterbase.dev
```

**Examples:**
- `my-todo-app.butterbase.dev`
- `blog-api.butterbase.dev`
- `ecommerce-backend.butterbase.dev`

**Fallback (App ID):**
```
{app-id}.butterbase.dev
```

**Examples:**
- `app-abc123def456.butterbase.dev`

**Legacy (Backwards Compatible):**
```
api.butterbase.ai/v1/{app-id}
```

---

## DNS Configuration

### Cloudflare DNS Records for butterbase.ai

```
Type: A
Name: @
Content: YOUR_VPS_IP
Proxy: Yes (orange cloud)
TTL: Auto
Comment: Main website

Type: A
Name: *
Content: YOUR_VPS_IP
Proxy: Yes (orange cloud)
TTL: Auto
Comment: Wildcard for platform subdomains

Type: A
Name: api
Content: YOUR_VPS_IP
Proxy: Yes
TTL: Auto
Comment: Platform API

Type: A
Name: dashboard
Content: YOUR_VPS_IP
Proxy: Yes
TTL: Auto
Comment: Dashboard UI
```

### Cloudflare DNS Records for butterbase.dev

```
Type: A
Name: *
Content: YOUR_VPS_IP
Proxy: Yes (orange cloud)
TTL: Auto
Comment: Wildcard for all user apps
```

**Note:**
- butterbase.ai handles platform services
- butterbase.dev is ONLY for user apps (wildcard only)
- No root record needed for butterbase.dev

---

## Database Schema Changes

### Migration: 010_app_subdomains.sql

```sql
-- Add subdomain column to apps table
ALTER TABLE apps ADD COLUMN subdomain TEXT UNIQUE;

-- Add custom domain support (for future)
CREATE TABLE app_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    domain TEXT NOT NULL UNIQUE,
    verified BOOLEAN NOT NULL DEFAULT false,
    verification_token TEXT,
    ssl_enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_app_domains_app_id ON app_domains(app_id);

-- Function to generate unique subdomain from app name
CREATE OR REPLACE FUNCTION generate_subdomain(app_name TEXT)
RETURNS TEXT AS $$
DECLARE
    base_subdomain TEXT;
    candidate TEXT;
    counter INTEGER := 0;
BEGIN
    -- Sanitize: lowercase, replace special chars with hyphens
    base_subdomain := lower(regexp_replace(app_name, '[^a-z0-9]+', '-', 'g'));
    base_subdomain := trim(both '-' from base_subdomain);

    -- Ensure starts with alphanumeric
    IF base_subdomain !~ '^[a-z0-9]' THEN
        base_subdomain := 'app-' || base_subdomain;
    END IF;

    -- Find unique subdomain
    candidate := base_subdomain;
    WHILE EXISTS (SELECT 1 FROM apps WHERE subdomain = candidate) LOOP
        counter := counter + 1;
        candidate := base_subdomain || '-' || counter;
    END LOOP;

    RETURN candidate;
END;
$$ LANGUAGE plpgsql;

-- Reserved subdomains (prevent user apps from claiming these)
CREATE TABLE reserved_subdomains (
    subdomain TEXT PRIMARY KEY,
    reason TEXT NOT NULL
);

INSERT INTO reserved_subdomains (subdomain, reason) VALUES
    ('api', 'Platform API'),
    ('dashboard', 'Platform dashboard'),
    ('app', 'Platform reserved'),
    ('www', 'Website'),
    ('admin', 'Administration'),
    ('auth', 'Authentication service'),
    ('docs', 'Documentation'),
    ('status', 'Status page'),
    ('blog', 'Blog'),
    ('help', 'Help center'),
    ('support', 'Support'),
    ('mail', 'Email service'),
    ('ftp', 'FTP service'),
    ('cdn', 'CDN'),
    ('static', 'Static assets');
```

---

## Provisioner Updates

### services/control-api/src/services/provisioner.ts

```typescript
export async function provisionApp(
  controlDb: pg.Pool,
  dataPlaneDb: pg.Pool,
  name: string,
  ownerId: string
): Promise<InitResponse> {
  // ... existing code ...

  const appId = `${APP_ID_PREFIX}${generateId()}`;
  const dbName = appId;

  // Generate unique subdomain from app name
  const { rows: subdomainRows } = await controlDb.query<{ subdomain: string }>(
    'SELECT generate_subdomain($1) as subdomain',
    [name]
  );
  const subdomain = subdomainRows[0].subdomain;

  // Insert app record with subdomain
  await controlDb.query(
    `INSERT INTO apps (id, name, owner_id, db_name, subdomain, db_provisioned)
     VALUES ($1, $2, $3, $4, $5, false)`,
    [appId, name, ownerId, dbName, subdomain]
  );

  // ... rest of provisioning ...
}

function formatResponse(app: App): InitResponse {
  const baseUrl = process.env.BASE_DOMAIN || 'butterbase.dev';
  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';

  return {
    app_id: app.id,
    name: app.name,
    subdomain: app.subdomain,
    urls: {
      api: `${protocol}://${app.subdomain}.${baseUrl}`,
      api_v1: `${protocol}://${app.subdomain}.${baseUrl}/v1`,
      auth: `${protocol}://${app.subdomain}.${baseUrl}/auth`,
      storage: `${protocol}://${app.subdomain}.${baseUrl}/storage`,
      functions: `${protocol}://${app.subdomain}.${baseUrl}/fn`,
      // Fallback URL using app ID
      api_by_id: `${protocol}://${app.id}.${baseUrl}`,
    },
    database: {
      host: config.pgbouncer.host,
      port: config.pgbouncer.port,
      name: app.db_name,
      user: config.dataPlaneDb.user,
      connection_string: `postgresql://${config.dataPlaneDb.user}:***@${config.pgbouncer.host}:${config.pgbouncer.port}/${app.db_name}`,
    },
    created_at: app.created_at.toISOString(),
  };
}
```

---

## Caddy Configuration

### Caddyfile

```caddy
# ============================================
# Platform (butterbase.ai)
# ============================================

# Main website
butterbase.ai {
    reverse_proxy landing-page:3000
}

# Platform API
api.butterbase.ai {
    reverse_proxy control-api:4000
}

# Dashboard
dashboard.butterbase.ai {
    reverse_proxy dashboard:3000
}

# Documentation (future)
docs.butterbase.ai {
    reverse_proxy docs:3000
}

# ============================================
# User Apps (butterbase.dev)
# ============================================

# Wildcard for all user app subdomains
*.butterbase.dev {
    reverse_proxy control-api:4000
}
```

**Features:**
- Automatic HTTPS via Let's Encrypt
- Automatic certificate renewal
- HTTP/2 and HTTP/3 support
- Wildcard SSL certificates for both domains
- Clear separation: Platform vs User Apps

---

## Subdomain Resolution Middleware

### services/control-api/src/plugins/subdomain.ts

```typescript
import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    appSubdomain: string | null;
    resolvedAppId: string | null;
  }
}

const subdomainPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('appSubdomain', null);
  fastify.decorateRequest('resolvedAppId', null);

  fastify.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host || '';

    // Check if this is a user app domain (butterbase.dev)
    const userAppRegex = /^([a-z0-9-]+)\.butterbase\.dev$/;
    const appIdRegex = /^(app_[a-z0-9]+)\.butterbase\.dev$/;

    const subdomainMatch = host.match(userAppRegex);
    const appIdMatch = host.match(appIdRegex);

    if (subdomainMatch) {
      const subdomain = subdomainMatch[1];
      request.appSubdomain = subdomain;

      // Look up app_id from subdomain
      const { rows } = await fastify.db.query(
        'SELECT id FROM apps WHERE subdomain = $1',
        [subdomain]
      );

      if (rows.length > 0) {
        request.resolvedAppId = rows[0].id;
      }
    } else if (appIdMatch) {
      request.resolvedAppId = appIdMatch[1];
    }

    // Platform domains (butterbase.ai) don't need resolution
    // They're handled by specific routes
  });
};

export default fp(subdomainPlugin);
```

---

## Example API Usage

### Creating an App

**Request:**
```bash
curl -X POST https://api.butterbase.ai/init \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-todo-app"}'
```

**Response:**
```json
{
  "app_id": "app_abc123def456",
  "name": "my-todo-app",
  "subdomain": "my-todo-app",
  "urls": {
    "api": "https://my-todo-app.butterbase.dev",
    "api_v1": "https://my-todo-app.butterbase.dev/v1",
    "auth": "https://my-todo-app.butterbase.dev/auth",
    "storage": "https://my-todo-app.butterbase.dev/storage",
    "functions": "https://my-todo-app.butterbase.dev/fn",
    "api_by_id": "https://app-abc123def456.butterbase.dev"
  }
}
```

### Using the App API

**All three URLs work:**

```bash
# 1. Friendly subdomain (recommended)
curl https://my-todo-app.butterbase.dev/v1/todos

# 2. App ID subdomain (fallback)
curl https://app-abc123def456.butterbase.dev/v1/todos

# 3. Legacy path-based (backwards compatible)
curl https://api.butterbase.ai/v1/app_abc123def456/todos
```

---

## Environment Variables

Add to `.env`:

```bash
# Domain configuration
BASE_DOMAIN=butterbase.dev
NODE_ENV=production

# For local development
# BASE_DOMAIN=localhost:4000
# NODE_ENV=development
```

---

## Testing Locally

### Option 1: /etc/hosts (Simple)

Add to `/etc/hosts`:
```
127.0.0.1 api.butterbase.local
127.0.0.1 my-app.butterbase.local
127.0.0.1 test-app.butterbase.local
```

Use `.local` TLD for development.

### Option 2: dnsmasq (Wildcard)

Install dnsmasq and configure:
```
address=/.butterbase.local/127.0.0.1
```

All `*.butterbase.local` subdomains resolve to localhost.

---

## Subdomain Collision Handling

The `generate_subdomain()` function automatically handles collisions:

```
Input: "my-app"
Output: "my-app"

Input: "my-app" (already exists)
Output: "my-app-1"

Input: "my-app" (my-app and my-app-1 exist)
Output: "my-app-2"
```

---

## Future: Custom Domains

Users can add their own domains later:

```bash
POST /v1/{app_id}/domains
{
  "domain": "api.mycompany.com"
}
```

Returns verification instructions (TXT record).

Once verified, both work:
- `my-app.butterbase.dev` (always works)
- `api.mycompany.com` (custom domain)

---

## Summary

**Domain Strategy:**
- **butterbase.ai** - Platform (website, API, dashboard, docs)
- **butterbase.dev** - User apps only (clean separation)

**What users get:**
- Instant, working URLs: `{app-name}.butterbase.dev`
- Professional appearance
- No DNS configuration needed
- Easy to remember and share
- Clear separation from platform
- Upgrade path to custom domains

**What you need:**
1. Two domains: butterbase.ai (platform) + butterbase.dev (user apps)
2. Wildcard DNS for both domains
3. Database migration: Add `subdomain` column
4. Subdomain middleware: Resolve subdomain → app_id
5. Caddy routing for both domains
6. Update provisioner response with URLs

**Implementation time:** ~1-2 days

**Benefits of two-domain strategy:**
- Clear branding separation
- Professional appearance
- SEO benefits (platform vs apps)
- Easier to explain to users
- Industry standard (Vercel uses .app for deployments, .com for platform)
