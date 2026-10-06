---
title: Custom Domains
description: Serve your Butterbase frontend from your own hostname, with automatic SSL.
---

Every frontend deployment gets a `*.pages.dev` URL for free. A **custom domain** puts that same deployment on a hostname you own — `app.example.com`, or the apex `example.com` — with an SSL certificate Butterbase issues and renews for you.

Custom domains are a **Launch plan or above** feature.

## How it works

Butterbase uses Cloudflare for SaaS. When you add a hostname:

1. Butterbase registers it as a *custom hostname* with Cloudflare and stores it against your app.
2. A KV mapping is written so the edge dispatcher knows which app that hostname belongs to.
3. You point DNS at us and prove you own the name.
4. Cloudflare issues a certificate. Renewal is automatic and you never touch it.

You keep control of your DNS the whole way through — nothing about this requires moving your domain to Cloudflare.

## Requirements

| Requirement | Why |
|---|---|
| Launch plan or above | The `custom_domain` plan feature gates the endpoint. Playground apps get a `403`. |
| The app owns the domain | A hostname is globally unique across Butterbase — a second app adding the same name gets a `409`. |
| A live frontend deployment | The domain routes to whatever the app currently serves. Add the domain first if you like; it just won't have anything to serve yet. |
| WfP deployment backend | Apps on the legacy backend return `400`. New apps are already on WfP. |
| Access to your DNS provider | You must be able to create CNAME and TXT records. |

## Step 1 — Pick a validation method

`validation_method` decides how Cloudflare proves you own the hostname before it issues a certificate. Choosing wrong here is the single most common reason a domain sits at "pending" forever.

| Method | How it works | Use it when | Do **not** use it when |
|---|---|---|---|
| `http` *(default)* | Cloudflare serves a challenge file from our zone; you only add the routing CNAME | Subdomains, and any DNS provider that isn't Cloudflare | Your DNS is a Cloudflare-**proxied** zone, or the hostname is an **apex on Cloudflare** — the orange-cloud intercept swallows the challenge, and CNAME flattening hides the record entirely |
| `txt` | Cloudflare gives you a TXT record to add in DNS | Apex domains on Cloudflare, proxied zones, or any time you want the method that always works | — |

Rule of thumb: **subdomain on a normal DNS provider → `http`. Anything on Cloudflare, or any apex → `txt`.**

## Step 2 — Add the domain

**Dashboard:** **App → Settings → Custom domains → Add domain.**

**CLI:**

```bash
butterbase domains add app.example.com
butterbase domains add example.com --validation-method txt
```

**REST API:**

```
POST /v1/{app_id}/custom-domains
Authorization: Bearer {token}

{ "hostname": "app.example.com", "validation_method": "http" }
```

**MCP:**

```
manage_frontend({
  app_id: "app_abc123",
  action: "configure_custom_domain",
  domain_action: "add",
  hostname: "app.example.com"
})
```

The `201` response carries everything you need for the next step:

```json
{
  "domain": { "id": "…", "hostname": "app.example.com", "status": "pending", "ssl_status": "pending" },
  "cname_target": "butterbase.dev",
  "validation_method": "http",
  "verification_records": [{ "txt_name": "_acme-challenge.app.example.com", "txt_value": "…" }],
  "ownership_verification": null,
  "instructions": "Add a CNAME record at your DNS provider: …"
}
```

Keep `domain.id` — it's what the status, verify, and delete calls take.

## Step 3 — Add your DNS records

### If you chose `http`

One record:

| Type | Name | Value |
|---|---|---|
| CNAME | `app.example.com` | `butterbase.dev` |

:::caution
**Cloudflare DNS users: set this record to DNS-only (grey cloud).** A proxied (orange cloud) CNAME pointing between two different Cloudflare accounts returns **Error 1014** and will never work.
:::

### If you chose `txt`

Two records, sometimes three:

| # | Type | Name | Value |
|---|---|---|---|
| 1 | CNAME | `app.example.com` | `butterbase.dev` — for an apex, use whatever your provider offers at the root (Cloudflare's flattened CNAME is fine) |
| 2 | TXT | `verification_records[].txt_name` | `verification_records[].txt_value` — authorizes the certificate |
| 3 | TXT | `ownership_verification.name` | `ownership_verification.value` — **only** returned for Cloudflare-proxied zones; add it if present |

If `verification_records` came back empty, Cloudflare hasn't minted the record yet. Call the status endpoint in a minute and it will be there.

## Step 4 — Watch it go active

```bash
butterbase domains status <domain-id>
```

```
GET /v1/{app_id}/custom-domains/{domain_id}/status
```

The endpoint re-reads live state from Cloudflare on every call and writes it back, so it's always current.

```json
{
  "domain": {
    "hostname": "app.example.com",
    "status": "active",
    "ssl_status": "active",
    "verification_errors": null
  },
  "cname_target": "butterbase.dev",
  "verification_records": [],
  "ownership_verification": null
}
```

| Field | Meaning |
|---|---|
| `status` | Cloudflare's hostname state. `pending` → waiting on DNS/validation. `active` → routing works. |
| `ssl_status` | Certificate state. `pending`/`initializing`/`pending_validation` → still issuing. `active` → HTTPS works. |
| `verification_errors` | Populated when Cloudflare rejected validation — read this first when something is stuck. |

**You're live when `status` and `ssl_status` are both `active`.** Typical time is 5–15 minutes; DNS propagation is usually the long pole.

If it's stuck, re-trigger validation without recreating the domain (this preserves the original `validation_method`):

```bash
butterbase domains verify <domain-id>
```

```
POST /v1/{app_id}/custom-domains/{domain_id}/verify
```

## Apex vs `www`

Butterbase does **not** force a redirect between the apex and `www`. Both are just hostnames; either can be canonical.

- Decide which one is canonical and add **that one** as the custom domain.
- Redirect the other at your DNS provider's edge (Cloudflare Redirect Rules, Netlify/Vercel DNS redirects, an ALIAS + rule at your registrar, etc.).
- Apex on Cloudflare requires `validation_method: "txt"`. Apex on a provider that supports CNAME flattening works with `http`.
- No CNAME flattening available? Use `www.example.com` as the custom domain and redirect the apex to it.

## Managing domains

| Method | Path | MCP `domain_action` | Purpose |
|--------|------|---------------------|---------|
| POST | `/v1/{app_id}/custom-domains` | `add` | Add a hostname (accepts `validation_method`) |
| GET | `/v1/{app_id}/custom-domains` | `list` | List every hostname on the app |
| GET | `/v1/{app_id}/custom-domains/{id}/status` | `status` | Live verification + SSL status |
| POST | `/v1/{app_id}/custom-domains/{id}/verify` | `verify` | Re-trigger validation |
| DELETE | `/v1/{app_id}/custom-domains/{id}` | `remove` | Remove the hostname |

```bash
butterbase domains list
butterbase domains add <hostname> [--validation-method http|txt]
butterbase domains status <domain-id>
butterbase domains verify <domain-id>
butterbase domains delete <domain-id> [--yes]
```

```typescript
await bb.admin.domains.list();
await bb.admin.domains.add('app.example.com', 'txt');
await bb.admin.domains.getStatus(domainId);
await bb.admin.domains.verify(domainId);
await bb.admin.domains.remove(domainId);
```

:::caution
Deleting a domain stops all traffic to that hostname immediately. Visitors get an error until you point DNS somewhere else.
:::

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `403` on add | App's org is on a tier without `custom_domain` | Upgrade — see [Plans & Usage](/core-concepts/plans-and-usage/) |
| `409 already registered` | The hostname is claimed — by this app, or another one | If it's this app, just check status. Otherwise pick a different hostname. |
| `400` about the deployment backend | App is on the legacy backend | Migrate the app to the WfP backend first |
| `503 Cloudflare is not configured` | Self-hosted instance without Cloudflare credentials | Configure Cloudflare on the control API |
| **Error 1014** in the browser | Proxied (orange-cloud) CNAME across Cloudflare accounts | Switch the record to DNS-only (grey cloud) |
| Stuck `pending` on an apex | Used `http` on a Cloudflare-hosted zone | Delete and re-add with `validation_method: "txt"` |
| `ssl_status` stuck, `status` active | TXT validation record missing or wrong | Re-read `verification_records` from the status endpoint and fix the record, then `verify` |
| Domain resolves but shows the old site | Edge cache after a redeploy | Wait a few minutes and hard-refresh — see [Frontend Deployment](/core-concepts/frontend-deployment/) |

## Related

- [Frontend Deployment](/core-concepts/frontend-deployment/) — getting a site live in the first place
- [Edge SSR Deployment](/core-concepts/edge-ssr-deployment/) — server-rendered apps
- [Plans & Usage](/core-concepts/plans-and-usage/) — which plans include custom domains
- Cloned an app? Custom domains do **not** transfer — see [Configuring Your Clone](/templates/configure/)
