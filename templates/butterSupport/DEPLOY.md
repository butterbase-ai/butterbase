# Deploying a butterSupport clone

## The gotcha (why this doc exists)

The support console (the React app at `<subdomain>.butterbase.dev`) also has to
serve the customer-facing floating widget as `/widget.js`. That widget is a
**separate Vite build** (`vite build --mode widget`). If you ship a dist/
without `widget.js` in it, every embedder's `<script src=".../widget.js">` tag
404s and no widget ever renders — silently, since the tag is `async`.

On top of that, the install snippet the console shows on its Setup / Settings
page is built from `import.meta.env.VITE_BUTTERBASE_SUBDOMAIN`, which is baked
in **at build time**. If you build with the wrong subdomain, every clone will
tell its embedders to point at the wrong host.

Both failures happened on wsgr-support on 2026-07-20. This doc + the guardrails
in `zip-dist.js` and `frontend/package.json` are meant to prevent a repeat.

## Deploy checklist (per clone)

From `frontend/`:

```
VITE_BUTTERBASE_SUBDOMAIN=<clone-subdomain> \
DEPLOY_APP_ID=<app_xxxxxxxxxxxx> \
npm run deploy
```

- `VITE_BUTTERBASE_SUBDOMAIN` — the target clone's subdomain, e.g.
  `wsgr-support`. Baked into the console bundle. Also used by the
  Widget/Setup install snippet.
- `DEPLOY_APP_ID` — the target clone's app id, e.g. `app_pwnxp63j0p0b`.
  Injected into `dist/index.html`'s `<meta name="butterbase-app-id">` by
  `zip-dist.js`.

The `deploy` script will refuse to run if either env var is missing.

`npm run deploy` produces `../frontend.zip`. Then upload it to the target app:

1. `mcp__butterbase__create_frontend_deployment { app_id }` — returns an
   `uploadUrl` and `deployment_id`.
2. `curl -X PUT --data-binary @../frontend.zip -H "Content-Type: application/zip" <uploadUrl>`
3. `mcp__butterbase__manage_frontend { app_id, action: "start_deployment", deployment_id }`

Verify: `curl -sI https://<subdomain>.butterbase.dev/widget.js` should be `200`.

## Guardrails in the repo (do not remove)

- **`zip-dist.js`** bails if `dist/widget.js` is missing — catches
  console-only builds before they ship.
- **`package.json`** no longer exposes `build:console`. Only `build` (which
  runs console + widget) and `build:widget` remain, so the natural muscle-
  memory command produces a complete dist.
- **`package.json` `deploy` script** requires `VITE_BUTTERBASE_SUBDOMAIN` and
  `DEPLOY_APP_ID` via `${VAR:?msg}` — the build won't start with the wrong or
  missing config.

## When adding a new clone

1. Provision the clone (`manage_app clone` or dashboard).
2. Get its `app_id` and `subdomain` from `manage_app list`.
3. **Lock it down.** A fresh clone inherits the source template's
   `access_mode: "public"` and its CORS `allowed_origins`. That means
   anyone can hit the auto-REST endpoints without a JWT and read/write
   your tables directly. Fix before doing anything else:
   ```
   manage_app { action: "update_access_mode", app_id, access_mode: "authenticated" }
   manage_app { action: "update_cors", app_id, allowed_origins: [
     "https://<subdomain>.butterbase.dev",         // the console itself
     "https://<embedder-domain>",                   // wherever the widget lives
     "http://localhost:5173", "http://localhost:3000"
   ] }
   ```
   Safe to do: the public widget functions (`widget-ingest`,
   `widget-followup`, `widget-fetch-history`) declare `auth: "none"` on
   their trigger, which overrides the app-level mode — so anonymous
   visitors keep working while direct REST access is blocked.
4. Run the deploy checklist above.
5. Paste the install snippet the console's Setup page now shows into the
   embedder's `<head>`. It should read:
   `<script async src="https://<subdomain>.butterbase.dev/widget.js" data-app-id="app_xxxx"></script>`
6. When the embedder later gets a real domain, add that origin via
   `manage_app update_cors` or the widget's fetches will be CORS-blocked.

## Local dev

`.env.local` is fine for local dev — it can keep pointing at the source
template (`butter-support` / `app_0ycj4ad7odud`). Only the `deploy` path
requires the per-clone env vars.
