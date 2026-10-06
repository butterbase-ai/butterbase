# Butter Support — Frontend

Vite + React + TypeScript frontend for the **butter-support** recipe. Builds two artifacts from a single project:

1. **Console SPA** (`index.html` → `dist/index.html` + `dist/assets/*`) — the support team's workspace.
2. **Customer widget** (`widget.html` → `dist/widget.js`) — a single-file IIFE bundle embedded on customer sites.

## Setup

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev          # http://localhost:5173
```

Required env vars (Vite picks up `VITE_*` at build time):

| Name | Example |
|---|---|
| `VITE_BUTTERBASE_APP_ID` | `app_0ycj4ad7odud` |
| `VITE_BUTTERBASE_API_URL` | `https://api.butterbase.ai` |
| `VITE_BUTTERBASE_SUBDOMAIN` | `butter-support` |

## Build

```bash
npm run build        # tsc --noEmit + vite build → dist/
npm run zip          # archiver-based zip → ../frontend.zip (forward-slash entries)
npm run deploy       # both
```

`dist/` contains:
- `index.html`
- `assets/` (hashed JS/CSS)
- `widget.js` (single-file IIFE)
- `_redirects` (so `/widget.js` and `/widget.css` are served as-is, everything else falls back to `index.html`)

## Deploying to Butterbase Frontend Hosting

The deploy stage of the journey will run:

```
mcp__butterbase__create_frontend_deployment app_id=app_0ycj4ad7odud framework=react-vite
# → returns { upload_url, deployment_id }
curl -X PUT "<upload_url>" -H "Content-Type: application/zip" --data-binary @frontend.zip
mcp__butterbase__manage_frontend action=start_deployment deployment_id=<id>
mcp__butterbase__manage_frontend action=set_env vars='{"VITE_BUTTERBASE_APP_ID":"app_0ycj4ad7odud", ...}'
```

After deployment, the owner must call `manage_app update_cors` with the deployed subdomain.

## Widget embed snippet

Customers paste this onto their site. The widget needs only the app id; it mints an anonymous visitor token on its own (no server-side signing).

```html
<script async src="https://butter-support.butterbase.dev/widget.js" data-app-id="app_0ycj4ad7odud"></script>
```

To attach the signed-in user, call `window.ButterSupport.identify({ user_id, email, name })` (or push `['identify', {...}]` onto `window.ButterSupport.q` before the bundle loads). Identity is client-supplied and not signature-verified.

## Local widget test

Open `test-widget.html` (from `frontend/`) after `npm run dev` or after `npm run build && npm run preview`. Verify the bundle loads without console errors (API calls need a valid `data-app-id` / app id).

## Project layout

See `src/console/` and `src/widget/`. Console uses `react-router-dom` v7, `@tanstack/react-query` v5, Tailwind v3, and `@butterbase/sdk`. Widget is fully standalone (vanilla `fetch`, no SDK).
