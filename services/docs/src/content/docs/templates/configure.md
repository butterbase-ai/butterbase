---
title: Configuring Your Clone
description: The post-clone checklist — what transferred, what didn't, and what to set up before you ship.
---

A finished clone is a working backend, not a finished product. Everything the source owner held as a secret, and everything tied to their identity or billing, stopped at the boundary. This page is the list of what you now have to supply.

## What transferred

| | |
|---|---|
| **Schema** | Tables, columns, types, indexes |
| **Security** | Row-level security policies, access mode |
| **Functions** | Function code, deployed to your app |
| **Durable Objects** | Class definitions, redeployed on your namespace |
| **Repo** | The source's latest pushed snapshot |
| **Config** | Storage settings, CORS allowed origins, OAuth provider list and redirect URLs, AI model defaults |
| **App env vars** | App-level environment variables, values included |
| **Seed data** | Rows in tables the publisher marked `_seed: true` |

## What did not transfer

| | Why |
|---|---|
| End-user accounts and sessions | They belong to the source app's users |
| OAuth **client secrets** | The source owner's credentials |
| Function environment variable **values** | Secrets — you got the key names, not the values |
| Durable Object env values | App-scoped secrets; never copied |
| BYOK AI provider keys | The source owner's billing |
| [Custom domains](/core-concepts/custom-domains/) | Tied to DNS you don't control |
| Stripe Connect / plans / products | The source owner's Stripe account |
| Frontend deployments | Deploy your own |
| Invocation history, audit logs | Not yours |

## The checklist

### 1. Read the clone job's warnings

```
manage_app action: "get_clone_job", job_id: "<job_id>"
```

Do this first. Warnings tell you what the pipeline couldn't reproduce — most importantly a **broken auth hook binding** (left `NULL`) and any **minted webhook secret**, which is shown exactly once.

### 2. Fill in the remaining function env vars

Preflight told you which keys were `user_required`. Anything you didn't pass at clone time is still empty, and the function will fail at runtime rather than at deploy time.

```
manage_function action: "update_env"
  app_id: "<your_new_app_id>"
  function_name: "send-invite"
  env: { "RESEND_API_KEY": "re_..." }
```

You can also set them in **App → Functions → *function* → Environment** in the dashboard.

Check what's still missing with `unfilled_env_vars` on the clone job, or with `manage_function action: "get"` on each function.

### 3. Re-set Durable Object env vars

DO environment values are never carried across a clone. Every non-convention key must be re-set:

```
manage_durable_objects action: "set_env"
  app_id: "<your_new_app_id>"
  name: "<do_class_name>"
  key: "OPENAI_API_KEY"
  value: "sk-..."
```

One key per call — repeat for each. `action: "list_env"` shows which keys exist.

### 4. Add your own OAuth client credentials

The provider *list* and redirect URLs copied; the client id/secret pairs did not. For each provider the template used, register an app with that provider and configure it:

```
manage_oauth action: "configure"
  app_id: "<your_new_app_id>"
  provider: "google"
  client_id: "..."
  client_secret: "..."
  redirect_uris: ["https://api.butterbase.ai/auth/<your_new_app_id>/oauth/google/callback"]
```

Update the redirect URLs to point at **your** domains — the copied ones point at the source app's. See [Authentication](/core-concepts/authentication/).

### 5. Rebind the auth hook if the warning said so

If a warning reported the auth hook couldn't be bound, set it once the function exists:

```
manage_auth_config action: "configure_auth_hook", app_id: "<app_id>", post_auth_function: "<fn>"
```

### 6. Add AI keys, if the template uses AI

The clone inherits the source's model defaults but not their BYOK keys. Either let it run on your Butterbase AI credits, or add your own keys:

```
manage_ai action: "update_config", app_id: "<app_id>", config: { byokKey: "sk-ant-..." }
```

See [AI Integration](/core-concepts/ai-integration/).

### 7. Update CORS for your frontend

The copied `allowed_origins` list points at the source's domains. Replace it:

```
manage_app action: "update_cors"
  app_id: "<app_id>"
  allowed_origins: ["https://myapp.com", "http://localhost:5173"]
```

### 8. Deploy a frontend

Nothing is deployed on a fresh clone. Build and deploy — see [Frontend Deployment](/core-concepts/frontend-deployment/). Remember frontend build env vars (`VITE_*` / `NEXT_PUBLIC_*`) are separate from function env vars and must be set on your app.

### 9. Add a custom domain

Optional, and only on Launch or above. See [Custom Domains](/core-concepts/custom-domains/).

### 10. Set up charging, if you're selling

Stripe Connect does not transfer. If the template ships a paywall, plans, or products, you need your own Connect account and your own plan/product rows. See [Charging Your Users](/core-concepts/billing/).

### 11. Review the security posture before you go live

Never assume an inherited configuration is safe for your use case.

- Check the app's access mode: `manage_app action: "get_config"`.
- Read every RLS policy that came across — [Row-Level Security](/core-concepts/row-level-security/) has a debugging guide.
- Confirm no seed row contains data you don't want to ship.
- If the template was built for a demo, it may be deliberately permissive.

### 12. Bind your local checkout

If you cloned from the dashboard or MCP and want the files locally:

```bash
butterbase repo init <your_new_app_id>
butterbase repo pull
```

The CLI's `butterbase clone` already did this for you.

## Verifying the clone works

1. `manage_schema action: "get"` — the expected tables exist.
2. `select_rows` on a seeded table — seed data landed.
3. `invoke_function` on each function — a `500` here is almost always a missing env var.
4. Sign up a test end user through your auth config.
5. Deploy the frontend and click through the primary flow.

:::caution
A function's `status` field can read `error` from a deploy attempt that has since been superseded. Invoke the function before you trust the status.
:::
