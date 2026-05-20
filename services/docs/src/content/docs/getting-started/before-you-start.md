---
title: Before You Start
description: Platform constraints and architecture choices to know before building on Butterbase.
---

Read this before you start. It takes 5 minutes and can save you from rebuilding your architecture later.

## What Butterbase is

Butterbase is a backend platform: managed PostgreSQL database, JWT authentication, S3-compatible storage, serverless functions, and frontend hosting — all agent-friendly and accessible via MCP or CLI.

## What Butterbase is NOT

### Not a full Node.js / Next.js hosting platform

You can run Next.js apps, but only in two flavors:
- **Static export** (`next export`) → deploy via [Frontend Deployment](/core-concepts/frontend-deployment) (static files only)
- **Server-side Next.js with SSR** → deploy via [Edge SSR Deployment](/core-concepts/edge-ssr-deployment), which compiles to Cloudflare Workers (not Node.js)

**You cannot** upload your Node.js next.config.js or use native Node APIs (`fs`, `child_process`, etc.) in a standard Next.js server deployment. If you need Node.js APIs, use Serverless Functions instead.

### Not stateful by default

Most apps use stateless [Functions](/core-concepts/functions/) or [Edge SSR](/core-concepts/edge-ssr-deployment/). For per-key stateful coordination (chat rooms, games, agents) use [Durable Objects](/core-concepts/durable-objects/).

### Not MySQL/MongoDB/etc.

**PostgreSQL only.** We use Neon for managed Postgres, but the API is standard PostgreSQL. No other databases.

## Architecture decision tree

Pick your stack based on what you're building:

- **Vite SPA or static HTML?** → [Frontend Deployment](/core-concepts/frontend-deployment)
- **Next.js with `output: 'export'`?** → [Frontend Deployment](/core-concepts/frontend-deployment) (static)
- **Next.js with server actions, RSCs, or route handlers?** → [Edge SSR Deployment](/core-concepts/edge-ssr-deployment) (with `@cloudflare/next-on-pages` build step)
- **Remix or other Workers-compatible framework?** → [Edge SSR Deployment](/core-concepts/edge-ssr-deployment)
- **Real-time / stateful per-room or per-user (chat, games, agents, leaderboards)?** → [Durable Objects](/core-concepts/durable-objects)
- **Backend logic, webhooks, API endpoints, cron jobs?** → [Serverless Functions](/core-concepts/functions) (Deno runtime)
- **Database queries?** → Direct PostgreSQL via auto-generated REST API or from functions/Edge SSR apps
- **File uploads/downloads?** → [File Storage](/core-concepts/storage) (S3-compatible)
- **Real-time updates?** → [Realtime](/core-concepts/realtime) (WebSocket)
- **AI model calls?** → [AI Integration](/core-concepts/ai-integration) (OpenAI-compatible API)

## Common gotchas

### "I want to use Prisma"

Only the HTTP adapter works: `@prisma/adapter-neon` over network connections.

```typescript
import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';

// ✅ Works — HTTP over network
const prisma = new PrismaClient({
  adapter: new PrismaNeon(neon_connection_string),
});

// ❌ Doesn't work — binary driver
const prisma = new PrismaClient(); // fails without adapter
```

The native Prisma client (socket-based binary driver) does not work on Cloudflare Workers or in Deno serverless functions.

### "I want to deploy a Next.js app"

You have two choices:

1. **Static export** (`next build && next export` → `out/`) — Deploy via [Frontend Deployment](/core-concepts/frontend-deployment). No SSR.
2. **Full Next.js with SSR** — Must compile with `@cloudflare/next-on-pages` first, then deploy via [Edge SSR Deployment](/core-concepts/edge-ssr-deployment). This replaces your normal `npm run build` workflow.

There is no third option. The dashboard's frontend deployment is static-only.

**Don't want to install build tools locally?** Both `butterbase deploy` and `butterbase deploy:edge-ssr` accept `--from-source`. Butterbase will run `npm install` and your build command in a Cloudflare Container, no local toolchain required. See [Server-Side Build](/core-concepts/server-side-build/).

### "My function uses a Node-only npm package"

Serverless Functions run on Deno, not Node.js. Packages requiring Node APIs (`fs`, `path`, `child_process`) will fail.

Before using a package, check:
- Does it work in Deno? (Check its README or test locally)
- Does it work in Cloudflare Workers? (Many packages support both)

When in doubt, test locally in your edge/serverless environment before deploying.

## Where to go next

- [Quickstart](/getting-started/quickstart) — Build your first app in 5 minutes
- [Database & Schema](/core-concepts/database) — Define your data model
- [Serverless Functions](/core-concepts/functions) — Write backend logic
- [Frontend Deployment](/core-concepts/frontend-deployment) — Deploy static frontends
- [Edge SSR Deployment](/core-concepts/edge-ssr-deployment) — Deploy server-side Next.js apps
- [Architecture](/core-concepts/authentication) — Learn about auth, RLS, and realtime
