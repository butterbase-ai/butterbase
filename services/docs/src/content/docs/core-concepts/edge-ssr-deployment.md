---
title: Edge SSR Deployment
description: Deploy server-side rendered Next.js and Remix apps via Cloudflare Workers with serverless backend integration.
---

Deploy server-side rendered Next.js and Remix applications directly from Butterbase. Use `@cloudflare/next-on-pages` to compile your app locally, zip the output, and deploy to Cloudflare Workers for fast edge execution.

:::tip[Skip local builds]
On Windows or want to avoid local toolchain setup? Use [Server-Side Build](/core-concepts/server-side-build/) — Butterbase runs `npm install` and `next-on-pages` for you.
:::

## What is Edge SSR?

Edge SSR (Server-Side Rendering) is a deployment model for server-centric frameworks running on Cloudflare Workers through Butterbase's WfP backend. Unlike static frontend deployment, Edge SSR allows your Next.js app to use server actions, route handlers, dynamic rendering, and React Server Components — without a traditional Node.js server.

**Key difference from static deployment:**
- **Static Frontend Deployment:** Your Vite SPA or statically-exported Next.js app is served as fixed HTML/CSS/JS files via Cloudflare Pages.
- **Edge SSR Deployment:** Your Next.js app's server logic runs on Cloudflare Workers, dynamically rendering pages and handling server actions at request time.

## When to use Edge SSR vs Static

| Use Case | Deployment | Notes |
|----------|-----------|-------|
| React SPA (Vite) | Static | Use [Frontend Deployment](/core-concepts/frontend-deployment) |
| Next.js with `output: 'export'` | Static | Fully static; no server needed |
| Next.js with App Router (RSCs, Server Components) | **Edge SSR** | Requires `@cloudflare/next-on-pages` build |
| Next.js with server actions | **Edge SSR** | Can't run on static hosting |
| Next.js with route handlers (`/api/...`) | **Edge SSR** | Need server runtime |
| Remix with server logic | **Edge SSR** | Supported; see frameworks table |
| Vite / Create React App | Static | Client-side rendering only |

## Prerequisites

You **must** compile your Next.js app locally using `@cloudflare/next-on-pages` before deploying. This tool converts your Next.js app into a Workers-compatible format.

1. Install the tool globally or as a dev dependency:

```bash
npm install -D @cloudflare/next-on-pages
# or
npx @cloudflare/next-on-pages
```

2. Run the build in your Next.js project root:

```bash
npx next build
npx @cloudflare/next-on-pages --build-cache-dir=.next
```

3. Verify the output:

```bash
ls -la .vercel/output/static/
# Should contain _worker.js and other static assets
```

:::caution
If you skip this step or see "_worker.js not found" during deployment, the deployment will fail. **This build step is mandatory — it cannot be skipped.**
:::

## Deployment flow

### Option 1: CLI

```bash
butterbase deploy:edge-ssr
```

This command:
- Detects your `.vercel/output/static/` directory (created by `@cloudflare/next-on-pages`)
- Zips the worker script and assets
- Uploads to your app on Butterbase
- Starts the deployment automatically

Environment variables are set via the dashboard or the `set_frontend_env` MCP tool and take effect on the next deploy. There is no `--env` flag on the CLI.

### Option 2: MCP

**Step 1: Create deployment**

```
create_edge_ssr_deployment({ app_id: "app_abc123", framework: "nextjs-edge" })
```

Response includes a `deployment_id` and `uploadUrl`.

**Step 2: Upload your zip**

```bash
cd .vercel/output/static/
zip -r ../../edge-ssr.zip .
curl -X PUT "{uploadUrl}" \
  -H "Content-Type: application/zip" \
  --data-binary @edge-ssr.zip
```

**Step 3: Start deployment**

```
start_edge_ssr_deployment({ app_id: "app_abc123", deployment_id: "uuid-1234" })
```

## Supported frameworks

| Framework | Value | Notes |
|-----------|-------|-------|
| Next.js | `nextjs-edge` | **Fully documented and tested in v1** |
| Remix | `remix-edge` | Supported via Cloudflare Workers adapter; see Remix docs |
| Other Workers-compatible | `other-edge` | Must output a `_worker.js` compatible with Cloudflare Workers |

:::note
Only Next.js is documented and officially tested in Butterbase v1. Other frameworks may work if they support Cloudflare Workers output, but we recommend starting with Next.js.
:::

## Runtime constraints (critical)

Edge SSR runs on Cloudflare Workers, not Node.js. Understand these limits before deploying:

### No arbitrary Node.js APIs
- ❌ `fs`, `fs/promises`
- ❌ `child_process`
- ❌ Native `crypto` module (use Web Crypto instead)
- ❌ `net`, `http` (use `fetch`)

### Prisma
Prisma only works via `@prisma/adapter-neon` over HTTP:

```typescript
import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import { Pool } from '@neondatabase/serverless';

const neon = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaNeon(neon);
const prisma = new PrismaClient({ adapter });

export const POST = async (req: Request) => {
  const user = await prisma.user.create({ data: { ... } });
  return Response.json(user);
};
```

The native Prisma client (binary driver) does **not** work on Cloudflare Workers.

### Timeouts and CPU
- Maximum 30 seconds per request
- 30 seconds of CPU time per Worker invocation (varies by plan)
- Streaming SSR optimization is automatic; no special setup required

### Dependencies
Check that your npm packages are Deno/Workers-compatible. Packages requiring Node.js APIs will fail at runtime. When in doubt, test locally:

```bash
npx @cloudflare/next-on-pages --build-cache-dir=.next
```

If you see build errors, you have incompatible dependencies.

## Edge runtime requirement

`@cloudflare/next-on-pages` only compiles pages and route handlers that opt into the edge runtime. Add this export at the top of every dynamic page, layout, and route handler:

```ts
// app/some-page/page.tsx, app/api/foo/route.ts, etc.
export const runtime = 'edge';
```

Without it, the build fails with `BUILD_NONZERO_EXIT` and a list of "incompatible" pages. The one exception is files marked `'use server'` (Server Actions) — see the pitfall below.

## Server Actions pitfalls

Server Actions have several Next.js-imposed rules that bite specifically when you deploy. Each of these fails silently or with a confusing error in production:

### `allowedOrigins` must include your Butterbase subdomain

Next.js wraps Server Actions in a CSRF check. By default it accepts only the development origin — calls from your deployed `*.butterbase.dev` (or custom) domain are rejected with no clear message. Add the deployed origin to `next.config.js`:

```js
/** @type {import('next').NextConfig} */
module.exports = {
  experimental: {
    serverActions: {
      allowedOrigins: ['my-app.butterbase.dev', 'app.example.com'],
    },
  },
};
```

If your app suddenly stops working after deploy and Server Actions return blank or 403-ish errors, check this first.

### Don't put `export const runtime = 'edge'` in a `'use server'` file

Files marked `'use server'` are only allowed to export async functions. Adding the `runtime` constant breaks the build with a confusing message. Server Actions inherit the runtime from the page that imports them, so just remove the export:

```ts
// app/actions.ts
'use server';

// ❌ export const runtime = 'edge';  // breaks the build

export async function createPost(formData: FormData) { ... }
```

### Re-throw `NEXT_REDIRECT` inside client `try/catch`

`redirect()` works by throwing a sentinel error with `digest` starting with `NEXT_REDIRECT`. If a client component wraps the action in `try/catch`, the redirect is swallowed and navigation never happens. Always re-throw it:

```ts
try {
  await myServerAction(formData);
} catch (err: any) {
  if (err?.digest?.startsWith('NEXT_REDIRECT')) throw err;
  setError(err.message);
}
```

## Size limits

- **Worker script:** 5 MB compressed (separate limit)
- **Total deployment:** 100 MB compressed (script + static assets)

If your deployment exceeds 5 MB:
1. Enable code splitting in `next.config.js`
2. Move heavy dependencies into edge functions (as separate Butterbase Serverless Functions)
3. Use tree-shaking optimizations in your build

Example `next.config.js`:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.optimization.splitChunks = {
      chunks: 'all',
      minSize: 20000,
    };
    return config;
  },
};

module.exports = nextConfig;
```

## Environment variables

Set environment variables via the dashboard or the `set_frontend_env` MCP tool — they take effect on the next deploy. There is no `--env` flag on the CLI.

Alternatively, use the REST API directly:

```json
PUT /v1/{app_id}/edge-ssr/env

{
  "DATABASE_URL": "postgresql://...",
  "NEXT_PUBLIC_API_BASE": "https://api.butterbase.ai"
}
```

**Important:** Environment variables are baked into the Worker script at deploy time. Changing variables requires a new deployment.

Framework-specific prefixes (same as static):
- **Next.js:** `NEXT_PUBLIC_` (visible in browser), `NEXT_` (server-only)
- **Remix:** Depends on your setup; check your `.env.server` file

## Replacement semantics

Only **one frontend per app** is active at any time:
- Deploying an Edge SSR app **replaces** any active static deployment
- Deploying a static frontend **replaces** any active Edge SSR deployment
- Older deployments are kept for rollback but are not served

To roll back to a previous deployment, redeploy the older version.

## Troubleshooting

### "_worker.js not found" on upload

**Cause:** You skipped the `@cloudflare/next-on-pages` build step.

**Fix:** Run the build in your Next.js root:

```bash
npx next build
npx @cloudflare/next-on-pages --build-cache-dir=.next
ls .vercel/output/static/_worker.js
```

Then re-upload the `.vercel/output/static/` folder.

### WORKER_TOO_LARGE

**Cause:** Your compiled Worker script exceeds 5 MB compressed.

**Fix:**
1. Enable code splitting in `next.config.js` (see Size Limits section)
2. Audit dependencies — remove or replace heavy packages
3. Move compute-heavy logic into Butterbase Serverless Functions, called from your Edge SSR app via API

### WRONG_BACKEND

**Cause:** Your app is not on the `wfp` backend (required for Edge SSR).

**Fix:** New apps default to `wfp`. For older apps, contact support or create a new app.

### Prisma/Neon connection errors

**Cause:** Using the native Prisma client instead of `@prisma/adapter-neon`.

**Fix:** Update your Prisma setup to use the Neon adapter (see Runtime Constraints section).

### Package import errors at runtime

**Cause:** A dependency uses Node.js APIs incompatible with Cloudflare Workers.

**Fix:** Test locally with `@cloudflare/next-on-pages`, check the build output for warnings, and replace or remove the incompatible package.

## Monitoring and logs

Once deployed, check status and logs via the dashboard or the `list_edge_ssr_deployments` MCP tool. Live request logs appear in the Butterbase dashboard under your app's Frontend section.
