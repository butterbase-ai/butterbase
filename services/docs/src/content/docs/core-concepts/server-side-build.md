---
title: Server-Side Build
description: Run npm install and your build command in a Cloudflare Container. Upload source, we deploy—no local toolchain required.
---

Butterbase can run `npm install` and your build command in a Cloudflare Container. Upload your source code, and Butterbase handles the rest. Skip local toolchain setup entirely — especially useful on Windows or when you want to avoid installing build tools.

## What it is

Server-Side Build is a deployment mode where:
1. You push your source code (with `package.json` and `package-lock.json` or `yarn.lock`)
2. Butterbase runs `npm install` inside a Cloudflare Container
3. Butterbase runs your build command (e.g., `npm run build` or `npx @cloudflare/next-on-pages`)
4. The output is deployed to your app

No local build step. No `@cloudflare/next-on-pages` on your machine. No Windows compatibility headaches.

## When to use it

- **Windows users:** Local `@cloudflare/next-on-pages` builds can be unreliable on Windows. Use server-side build instead.
- **Avoid local toolchain:** Don't want to install Node.js, npm, or build tools locally? Server-side build removes that requirement.
- **CI/CD:** Simplify your pipeline — no pre-build step, just deploy.

The pre-built upload path is still available if you prefer to build locally; use the `--prebuilt` flag on `butterbase deploy:edge-ssr` or `butterbase deploy`.

## Supported deploy types

| Deploy Type | Framework | Default Build Command | Default Output Dir |
|---|---|---|---|
| **Edge SSR** | Next.js | `npx @cloudflare/next-on-pages` | `.vercel/output/static` |
| **Edge SSR** | Remix | Your custom command | Your output dir |
| **Static** | Vite, CRA, Next-static, etc. | `npm run build` | Auto-detected (`dist`, `build`, `out`) |

## Quick start

### Edge SSR (Next.js)

```bash
butterbase deploy:edge-ssr --from-source
```

Butterbase will:
- Zip your source
- Run `npm install`
- Run `npx @cloudflare/next-on-pages`
- Deploy the output from `.vercel/output/static/`

### Static frontend

```bash
butterbase deploy --from-source
```

Butterbase will:
- Zip your source
- Run `npm install`
- Run `npm run build`
- Auto-detect your output directory
- Deploy the artifacts

## Defaults per deploy type

### Edge SSR

| Setting | Value |
|---|---|
| Build command | `npx @cloudflare/next-on-pages` |
| Output directory | `.vercel/output/static` |
| When to override | Different build output location or Remix setup |

To override:
```bash
butterbase deploy:edge-ssr --from-source --build-command "npm run build" --output-dir .output
```

### Static

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Output directory | Auto-detected: `dist`, `build`, `out` (in order) |
| When to override | Non-standard output location |

To override:
```bash
butterbase deploy --from-source --build-command "npm run prod-build" --output-dir .public
```

## Override flags

All flags work with both `butterbase deploy` and `butterbase deploy:edge-ssr --from-source`:

| Flag | Example | Purpose |
|---|---|---|
| `--build-command` | `--build-command "npm run custom"` | Override the default build command |
| `--output-dir` | `--output-dir ./dist` | Override the output directory |
| `--from` | `--from ./my-app` | Build from a subdirectory (monorepo support) |

Example:

```bash
butterbase deploy:edge-ssr --from-source \
  --build-command "npm run build:production" \
  --output-dir .vercel/output/static \
  --from apps/my-next-app
```

## Environment variables

Environment variables are set via the dashboard or the `set_frontend_env` MCP tool. They take effect on the next deployment and are used at **both build time and runtime**.

```bash
set_frontend_env({
  app_id: "app_abc123",
  env: {
    "NEXT_PUBLIC_API_BASE": "https://api.example.com",
    "DATABASE_URL": "postgresql://...",
    "ANALYTICS_KEY": "secret-key"
  }
})
```

**Important:** Environment variables are baked into your compiled output at build time as expected:
- **Next.js:** `NEXT_PUBLIC_*` variables are visible in browser JavaScript; other variables are server-only
- **Static frontends:** Only `NEXT_PUBLIC_*` or similar public prefixes will be baked in; consider a `.env.local` step if you need secrets at build time
- **Remix and others:** Depends on your setup; check your framework's environment variable documentation

## Limits

| Limit | Value | Notes |
|---|---|---|
| Source zip size | 50 MB | Pre-flight check; add `.gitignore`-style exclusions if you hit this |
| Build wall-clock time | 5 minutes | Consider optimizing slow steps (large deps, serial builds) |
| Build memory (RAM) | 2 GB | Most builds complete well under this; trim if you hit OOM |
| Compressed artifact | 25 MB | Your output must compress under this; tree-shake or split code if needed |
| Log file size | 5 MB | Build logs are capped; oldest lines are dropped if you exceed this |

## Caching

Butterbase caches `node_modules` across deployments keyed on **`(app_id, lockfile_hash)`**:

- **Same lockfile** → `node_modules` cache hit; `npm install` is skipped
- **Lockfile changes** → Cache miss; full `npm install` runs

This works for both `package-lock.json` (npm) and `yarn.lock` (Yarn). Lockfile is the cache key, not individual dependency versions.

## Failure modes

If a build fails, check the logs in the dashboard or via the CLI. Common failure reasons:

| Reason | Meaning | What to do |
|---|---|---|
| `BUILD_NONZERO_EXIT` | Your `npm install` or build command returned non-zero | Check the build logs; fix the command or dependency issue |
| `BUILD_TIMEOUT` | Build exceeded 5 minutes | Investigate slow steps; consider a tighter dependency tree or splitting builds |
| `BUILD_OOM` | Build exceeded 2 GB RAM | Trim your dependencies or split the build; some bundlers are memory-intensive |
| `SOURCE_TOO_LARGE` | Source zip > 50 MB | Add entries to `.gitignore`; remove vendored dependencies or large assets |
| `OUTPUT_NOT_FOUND` | Build succeeded but output dir is empty or missing | Override `--output-dir` to the correct location |
| `ARTIFACT_TOO_LARGE` | Compressed output > 25 MB | Tree-shake unused code, split bundles, or remove large dependencies |
| `DEPLOY_FAILED` | Cloudflare WfP rejected the artifact | Check logs; verify format matches your framework (e.g., `_worker.js` for Edge SSR) |
| `INTERNAL` | Butterbase infrastructure issue | File a bug; retry the deployment |

## Monitoring

Check build status and logs via the dashboard or the `list_edge_ssr_deployments` (Edge SSR) / `list_static_deployments` (Static) MCP tools.

Once deployed, live request logs appear in the Butterbase dashboard under your app's Frontend section.
