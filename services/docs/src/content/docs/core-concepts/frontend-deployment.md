---
title: Frontend Deployment
description: Deploy static frontends to a live URL with global delivery and HTTPS.
---

Deploy your frontend directly from Butterbase. Build your app locally, zip the output, upload it, and deploy to a live URL powered by Cloudflare Pages.

Frontend deployments are served globally and aren't tied to a single [region](/core-concepts/regions/) — your static assets reach users fast no matter where your app's backend lives.

## How it works

1. Call `create_frontend_deployment` to get a deployment ID and upload URL
2. Upload your built frontend as a zip file
3. Call `start_frontend_deployment` to trigger the deployment
4. Your site goes live at a `.pages.dev` URL

## Supported frameworks

| Framework | Value | Notes |
|-----------|-------|-------|
| React (Vite) | `react-vite` | `dist/` folder from `npm run build` |
| Next.js (static) | `nextjs-static` | `out/` folder from `next build && next export` |
| Static HTML | `static` | Any plain HTML/CSS/JS files |
| Other | `other` | Any framework that produces static output |

## Deploying via MCP

**Step 1: Create deployment**

```
create_frontend_deployment({ app_id: "app_abc123", framework: "react-vite" })
```

**Step 2: Upload your zip**

```bash
curl -X PUT "{uploadUrl}" \
  -H "Content-Type: application/zip" \
  --data-binary @frontend.zip
```

**Step 3: Start deployment**

```
start_frontend_deployment({ app_id: "app_abc123", deployment_id: "uuid-1234" })
```

## Deployment statuses

| Status | Meaning |
|--------|---------|
| `WAITING` | Created, awaiting zip upload |
| `UPLOADING` | Files are being processed |
| `BUILDING` | Deployment is being built |
| `READY` | Succeeded — URL is assigned |
| `ERROR` | Failed — check the error message |
| `CANCELED` | Deployment was canceled |

:::note
`READY` means the deployment is accepted by Cloudflare — but edge propagation can take several minutes. Verify by requesting the live URL before telling users the site is updated.
:::

## Creating the zip file correctly

:::caution
**Do not use** Windows File Explorer "Send to Compressed folder", PowerShell `Compress-Archive`, or `ZipFile.CreateFromDirectory` without explicit `/` paths. These tools create backslash paths inside the zip, causing Cloudflare Pages to serve assets with wrong MIME types.
:::

### Recommended: Node.js archiver

```bash
npm install archiver --save-dev
```

```javascript
// zip-dist.js
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const output = fs.createWriteStream(path.join(__dirname, 'frontend.zip'));
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`frontend.zip created (${archive.pointer()} bytes)`);
});

archive.on('error', (err) => { throw err; });
archive.pipe(output);
archive.directory('dist/', false);
archive.finalize();
```

### Alternative: Git Bash / WSL

```bash
cd dist && zip -r ../frontend.zip .
```

## Environment variables

Set environment variables for frontend builds:

```json
PUT /v1/{app_id}/frontend/env

{
  "VITE_API_URL": "https://api.butterbase.ai/v1/app_abc123",
  "VITE_APP_NAME": "My App"
}
```

Framework-specific prefixes:
- **Vite:** `VITE_` (e.g., `VITE_API_URL`)
- **Next.js:** `NEXT_PUBLIC_` (e.g., `NEXT_PUBLIC_API_URL`)
- **Create React App:** `REACT_APP_` (e.g., `REACT_APP_API_URL`)

## SPA routing

For single-page app frameworks, a `_redirects` file is automatically injected so all routes serve `index.html`. Client-side routing works out of the box. If your zip includes a custom `_redirects`, it is preserved.

## Redeployment

- **Free plan:** Deploying again automatically replaces your existing deployment.
- **Pro and above:** Each deployment is kept independently. Delete old deployments manually.

## Custom Domains

Connect your own domain to your deployed frontend. Requires **Pro plan or above**.

### Setup

1. Add your domain via the dashboard, CLI, or API
2. Add a CNAME record at your DNS provider pointing to `butterbase.dev`
   - **Cloudflare DNS users:** set the record to **DNS-only (grey cloud)**. Proxied (orange cloud) CNAMEs between different Cloudflare accounts produce Error 1014.
3. SSL is automatically provisioned — check status in the dashboard or via API
4. Once active, your site is live at your custom domain

### CLI

```bash
butterbase domains add app.example.com
butterbase domains status <domain-id>
```

### REST API

```
POST /v1/{app_id}/custom-domains
{ "hostname": "app.example.com" }
```

### Apex domains

For bare domains like `example.com`, your DNS provider must support CNAME flattening. Otherwise use `www.example.com` with a redirect from the apex.

## Limits

| Limit | Value |
|-------|-------|
| Maximum deployment size | 100 MB (compressed) |
| Upload URL expiration | 15 minutes |
| Free plan | 1 active deployment per app |
| Pro plan | Unlimited deployments |
