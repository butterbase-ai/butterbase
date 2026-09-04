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

Customers paste this onto their site. Three values must be rendered server-side per page load:

- `data-user-payload` — base64-encoded JSON `{user_id, email, name}`
- `data-user-ts` — unix milliseconds (`Date.now()`)
- `data-user-signature` — `HMAC-SHA256("${ts}.${payload}", widget_secret)` (hex)

The widget passes all three verbatim on every API call. The HMAC freshness window is 5 minutes, so re-render the snippet per page load.

```html
<script src="https://butter-support.butterbase.dev/widget.js"
  data-recipe-base="https://butter-support.butterbase.dev"
  data-user-payload="<base64 JSON>"
  data-user-signature="<hex HMAC>"
  data-user-ts="<unix ms>"></script>
<div id="butter-support-widget"></div>
```

## Local widget test

Open `test-widget.html` (from `frontend/`) after `npm run dev` or after `npm run build && npm run preview`. The widget will render in launcher mode but API calls will fail (no valid HMAC) — verify the bundle loads without console errors.

## Project layout

See `src/console/` and `src/widget/`. Console uses `react-router-dom` v7, `@tanstack/react-query` v5, Tailwind v3, and `@butterbase/sdk`. Widget is fully standalone (vanilla `fetch`, no SDK).
