---
title: Publishing a Template
description: Make one of your apps public so other people can clone it.
---

Any app you own becomes a template the moment you make it public and push a repo snapshot. There's no submission, no review queue, and no separate template object — the app *is* the template.

## Why publish

- **Distribution.** Listed templates show up in the dashboard's Templates browser and in `find_templates` for every AI agent connected to Butterbase.
- **A clone counter.** Every clone increments your app's `fork_count`, which is what "Popular" sorts on.
- **Onboarding that actually works.** Instead of a README telling someone to create eight resources by hand, they click Clone and have a running copy.
- **A hook into the moment someone clones.** Fire a webhook on every completed clone — greet the new owner, count adoption, trigger provisioning on your side.

## Requirements

| Requirement | Why |
|---|---|
| `visibility: public` | Clone refuses non-public sources with a `404` |
| At least one `butterbase repo push` | Clone refuses a source with no repo snapshot — that snapshot *is* the code that gets copied |
| `listed: true` (optional) | Controls discoverability, not clonability — see below |
| App is fully provisioned | Un-provisioned apps are filtered out of discovery |

## Step 1 — Prepare the app for other people

Do this before you flip visibility. Once the app is public, its schema, function code, repo files, and env var **key names** are readable by anyone.

- **Audit what's in your tables.** Only tables marked `_seed: true` get their rows copied, but the *schema* of every table is public. Don't ship column names that leak anything.
- **Audit your repo snapshot.** Whatever `butterbase repo push` uploaded is what people download. Check for committed `.env` files, fixture data with real customer records, hardcoded keys in source. Use the ignore rules — see [`butterbase repo`](/cli/repo/).
- **Audit your env var names.** Values never leave, but names are part of the public surface. `ACME_CORP_INTERNAL_TOKEN` tells a story.
- **Audit your RLS policies.** They copy verbatim. If your app is permissive because it's a demo, every clone inherits that. Consider tightening first — see [Row-Level Security](/core-concepts/row-level-security/).
- **Make sure it works from cold.** Clone your own app into a scratch app and run through it. That is the experience you're shipping.

## Step 2 — Add seed data

An empty app is a bad first impression. Mark a table with `_seed: true` in your schema and its rows travel with the clone:

```json
{
  "tables": {
    "categories": {
      "_seed": true,
      "id": "uuid primary key",
      "name": "text not null"
    }
  }
}
```

Tables without `_seed: true` clone with their schema only. Use this for reference data, example content, and demo rows — not for anything user-specific. See [Database & Schema](/core-concepts/database/#marking-tables-as-seed-data).

## Step 3 — Push your repo snapshot

```bash
butterbase repo init <app_id>     # once, binds the folder
butterbase repo push --message "Template release"
```

Pushes are content-addressed, so re-pushing is cheap. The **latest** snapshot is what clones copy — push again whenever you want new cloners to get updated code. Existing clones are unaffected; they took a copy.

## Step 4 — Make it public

**CLI:**

```bash
butterbase visibility public --listed
butterbase visibility public --unlisted
butterbase visibility private
```

**MCP:**

```
manage_app action: "set_visibility"
  app_id: "<app_id>"
  visibility: "public"
  listed: true
```

**REST:**

```json
PATCH /v1/{app_id}/config/visibility
{ "visibility": "public", "listed": true }
```

**Dashboard:** **App → Settings → Visibility.**

### `public` vs `listed`

| `visibility` | `listed` | Result |
|---|---|---|
| `private` | — | Not clonable at all |
| `public` | `true` | Clonable, **and** appears in the Templates browser and `find_templates` |
| `public` | `false` | Clonable by anyone who has the app id, but **not** discoverable |

`public` + `listed: false` is the "share this with my team / my course / my client" mode: send the app id to whoever needs it and nobody else can find it.

:::caution
Public means public. There is no per-user allowlist — an unlisted app id is a secret URL, not an access control.
:::

## Step 5 — Set a clone webhook (optional)

Get an HTTP callback whenever someone finishes cloning your app.

**MCP:**

```
manage_app action: "set_clone_webhook"
  app_id: "<app_id>"
  webhook_url: "https://example.com/hooks/butterbase-clone"
  webhook_secret: "<16-256 chars>"
```

**REST:**

```json
PATCH /v1/{app_id}/config/clone-webhook
{ "webhook_url": "https://example.com/hooks/clone", "webhook_secret": "…" }
```

Clear it with `{ "clear": true }`, or `clear_webhook: true` over MCP.

**The delivery:**

```
POST https://example.com/hooks/clone
Content-Type: application/json
X-Butterbase-Event: clone_completed
X-Butterbase-Signature: sha256=<hex>

{
  "event": "clone_completed",
  "job_id": "…",
  "source_app_id": "app_yours",
  "dest_app_id": "app_theirs",
  "dest_region": "us-west-2",
  "completed_at": "2026-08-26T12:00:00.000Z"
}
```

**Verify the signature.** It's HMAC-SHA256 of the raw request body, keyed with your secret, formatted `sha256=<hex>`:

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string, secret: string) {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Compute it over the **raw** body, not a re-serialized object. Return a `2xx` — non-2xx responses are retried with backoff and then dropped.

## Maintaining a template

**Publishing an update:** push a new repo snapshot and apply any schema migration to your app. New clones pick up the current state; existing clones don't change. There is no upgrade path from a template to its clones — a clone is a fork, not a subscription.

**Unpublishing:** set `visibility: private`. Existing clones keep working; they've been independent since the moment they completed.

**Versioning:** if you need a v1 and a v2 that both stay clonable, keep them as two apps. `repo` retains only the five most recent snapshots, and clones always take the latest.

## Checklist before you flip the switch

- [ ] No secrets, real customer data, or `.env` files in the repo snapshot
- [ ] Env var names give nothing away
- [ ] RLS policies are safe as a default for someone else's app
- [ ] Seed data is representative and contains nothing private
- [ ] You cloned it yourself and the clone actually runs
- [ ] A README in the repo explains what to configure post-clone
- [ ] `listed` set the way you want — discoverable, or id-only
