# @butterbase/static-frontend-worker

Per-app static frontend worker source for the Butterbase WfP dispatch namespace.

One copy of the compiled output of `src/worker.ts` is uploaded by `control-api` into the WfP dispatch namespace per customer app (script name = appId). The worker is bound to a Cloudflare Assets binding configured with `html_handling: 'none'` and serves content via an explicit path resolution chain with SPA fallback.

To modify worker behavior: edit `src/worker.ts`, rebuild, redeploy `control-api`.

## Layout

```
src/
  worker.ts                       # the worker (typed TS, compiles to dist/worker.js)
  worker.test.ts                  # unit tests vs hand-mocked env.ASSETS
  worker.miniflare.test.ts        # integration tests vs real workerd
  index.ts                        # exports worker handler + WORKER_SOURCE constant
  worker-source.generated.d.ts    # committed shim for the build-time generated module
scripts/
  emit-source.mjs                 # post-build: dist/worker.js → dist/worker-source.generated.js
  local-server.mjs                # local Miniflare HTTP server (dev mode)
local-assets/                     # sample SPA shipped for first-run of dev:serve
Dockerfile                        # for the `miniflare-frontend` compose service
```

## Build

```
npm run build
```

Compiles `src/worker.ts` → `dist/worker.js`, then runs `emit-source.mjs` which writes `dist/worker-source.generated.js` exporting the compiled bytes as a string constant. `control-api`'s `cloudflare-wfp.ts` imports `WORKER_SOURCE` from this package and uploads it verbatim to CF on each deploy.

`--force` is mandatory in the tsc invocation: the wrapper's `.dockerignore` strips `dist/` but not `tsconfig.tsbuildinfo`, so non-force builds inside docker skip emit.

## Test

```
npm test
```

Two test files:

1. **`worker.test.ts`** — Native Vitest against a hand-mocked `env.ASSETS`. Fast, deterministic, covers the resolution chain, SPA fallback, honest 404s for asset-shaped misses, error handling. ~10ms.

2. **`worker.miniflare.test.ts`** — Boots the actual compiled worker against Miniflare 4 (real `workerd` runtime + real Assets binding configured with `html_handling: 'none'`). Catches regressions where the hand-mock and real runtime diverge. ~350ms.

Note: Miniflare's default routes assets BEFORE the user worker (the standalone Workers Static Assets behavior). In a WfP dispatch namespace, the user worker is the entry point and `env.ASSETS` is just a binding it calls. The test enables `routerConfig.invoke_user_worker_ahead_of_assets: true` to match prod.

## Local dev — Mode 1: Miniflare HTTP server (host node)

```
npm run dev:serve
```

Boots Miniflare locally on `http://localhost:8787` serving `./local-assets/`. Customize via env vars:

| Env | Default | Notes |
|---|---|---|
| `LOCAL_FRONTEND_ASSETS_DIR` | `./local-assets` | Path to the dist/ to serve |
| `LOCAL_FRONTEND_PORT` | `8787` | Bind port |
| `LOCAL_FRONTEND_HOST` | `0.0.0.0` | `127.0.0.1` for loopback-only |
| `LOCAL_FRONTEND_HTML_HANDLING` | `none` | Mirror prod |

Try:

```
curl -sI http://localhost:8787/                  # 200 + text/html (home)
curl -sI http://localhost:8787/some/deep/route   # 200 + text/html (SPA fallback)
curl -sI http://localhost:8787/about             # 200 + text/html (resolves /about.html)
```

## Local dev — Mode 2: docker-compose service

`docker-compose.local.yml` ships a `miniflare-frontend` service:

```
docker compose -f docker-compose.local.yml up -d miniflare-frontend
curl -sI http://localhost:8787/                  # same probes as above
```

To serve your own SPA's `dist/` instead of the sample assets:

```
docker compose -f docker-compose.local.yml run --rm \
  -v "$(pwd)/path/to/your/dist:/app/local-assets" \
  -p 8787:8787 \
  miniflare-frontend
```

The container uses `node:22-slim` (debian, not alpine) because `workerd` is linked against glibc and crashes with `symbol not found` relocations on musl.

## `_redirects` support

Users can ship a `_redirects` file at the root of their `dist/` zip. At deploy time, `services/control-api/src/services/deployment.service.ts:deployViaWfp` parses the file via `parseRedirects` (in this package) and bakes the compiled rule table into the worker as the `BB_REDIRECTS_RULES` plain_text binding. The `_redirects` file itself is stripped from the uploaded asset bundle at deploy time — probing `/_redirects` returns 404. The worker applies rules before asset lookup, first match wins.

Supported subset (Cloudflare Pages-compatible):
- Comments (`#`)
- Blank lines
- `<from> <to> [status]` (default status `301`)
- Splat patterns: `from` may end with `/*`, `to` may reference `:splat`
- Status codes: `200` (rewrite — serve target content under the original URL), `301`/`302`/`303`/`307`/`308` (redirect — `Location` header)

Not yet supported (defer if a customer asks):
- Named placeholders (`:id`)
- Query/header matchers (`status=200 country=US`)
- Force-match `!`

Apps that don't ship `_redirects` keep the existing default: direct asset lookup with SPA fallback to `/` on miss. The `BB_*` binding namespace is reserved — user app env vars cannot override it (the deploy-time wire-up sets it after the user's env var loop).

### Behavior notes (Phase 5)

**`/index.html` and `/foo.html` serve directly.** With `html_handling: 'none'`, these paths are literal asset hits — the worker returns them with 200. There is no canonical redirect to `/` or `/foo`. Users who want CF Pages-style URL canonicalization can ship a `_redirects` rule:

```
/index.html / 301
/foo.html   /foo 301
```

**Non-html-extension misses return 404.** A request for `/missing.png`, `/missing.css`, or `/missing.js` that finds no matching file in the bundle returns 404 — not the `index.html` body. Frontend devs see honest network-tab status codes; broken image tags stop masquerading as HTML responses. Extensionless paths (`/history`, `/profile/42`) and `.html`/`.htm` paths still SPA-fallback to home on miss. This rule applies only when no explicit `200` rewrite rule matches first — for example, a user who ships `/* /index.html 200` will see `/missing.png` return the `index.html` body with status 200, matching Cloudflare Pages semantics.

**`/_redirects` returns 404.** The file is parsed at deploy time and stripped from the uploaded asset bundle. The parsed rules govern routing; the raw file is not served.

## Production deployment

This package's `WORKER_SOURCE` is uploaded to the WfP dispatch namespace as `worker.mjs` by `services/control-api/src/services/cloudflare-wfp.ts:deployUserWorker`. After upload, `services/control-api/src/services/deployment.service.ts:deployViaWfp` runs the SPA routing probe (PR #36) against the live URL and fails the deploy with `SPA_ROUTING_PROBE_FAILED` if the worker's fallback isn't resolving deep paths to 200 + text/html. Both layers together close the bug-via-user-complaint path.
