---
title: Staging Environments
description: A copy of your app you can safely break — with your real data — and promote back to production when it's ready.
---

A staging environment is a full copy of your app that you can experiment on without touching production. It has its own database, its own storage, its own auth users, and its own URL. When you're happy with a change, you promote it back to production.

Staging is an ordinary app under the hood, so everything you already know works there: the same MCP tools, the same REST API, the same dashboard pages.

## What staging contains

Staging starts as a copy of production, and that includes **your production data**:

- Every table's rows.
- Every signed-up account, with its password hash — so people can sign in to staging with the password they use on production.
- Every uploaded file.

:::caution[Staging holds a real copy of your users' data]
If your production app stores personal data, your staging app now stores a second copy of it. Anyone you give access to the staging app can read all of it. Treat it with the same care you treat production.
:::

### What deliberately does not travel

| Not copied | Why |
|---|---|
| App and function env var **values** | Staging must never hold your live secrets. The keys are created but left **empty**, so a function that needs one fails loudly instead of quietly using production's credentials. Set them with [env var overrides](#env-var-overrides). |
| Connected third-party accounts | Copied and then cleared, so staging can't act as you against Stripe, Google, or anything else. Reconnect them on staging if you need them. |
| Integration configs and cron triggers | Switched **off**. A staging copy of a nightly billing job should not run. |
| Billing and analytics history | Subscriptions, orders and daily activity belong to the production app. |

Storage object **ids** also change. If your app stores a storage object id inside one of its own tables, that column still points at production's object.

## Creating a staging environment

You get **one** staging environment per production app, and it's always created in the same region as production.

**MCP**

```
manage_staging({ app_id: "app_abc123", action: "create" })
```

**REST**

```bash
curl -X POST https://api.butterbase.ai/v1/apps/app_abc123/staging \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
```

**Dashboard** — open your app and choose **Staging** in the sidebar.

Creating returns a `job_id`. The job copies your data, which takes as long as your data needs, so it is not instant:

```
manage_staging({ app_id: "app_abc123", action: "status" })
```

A job that has not reached `completed` is **not** a usable staging environment. Until it finishes, the staging app is not linked and won't appear in `status`.

## Env var overrides

Staging inherits your env var *keys* but none of their *values*. Overrides are how you fill them in — typically with sandbox credentials, so staging talks to Stripe test mode while production keeps the live key.

```
manage_staging({
  app_id: "app_abc123",
  action: "set_env_overrides",
  env_overrides: { PAYMENT_PROVIDER_KEY: "sk_test_..." }
})
```

Two things worth knowing:

- Overrides are keyed on the **production** app, so you can set them *before* creating staging and it comes up working, and they survive a reset or an unlink-and-recreate.
- Reading them back returns key **names** only, never values.

Setting overrides replaces the whole set. Pass an empty object to clear it.

## Promoting to production

Promote applies staging's **shape** to production: schema, RLS policies, functions, Durable Objects, config, and the repo snapshot — and it deploys the frontend. It is a real production deploy.

**Data is never promoted.** Production rows are never overwritten or removed. If you added a table in staging, promote creates that table in production — empty.

Always preview first:

```
promote_staging({ app_id: "app_abc123", action: "preview" })
```

```json
{
  "can_promote": true,
  "additive": ["ALTER TABLE orders ADD COLUMN refunded_at timestamptz"],
  "blocked": [],
  "ignored_removals": []
}
```

Then run it:

```
promote_staging({ app_id: "app_abc123", action: "run" })
```

### What promote refuses

Promote will not destroy production data. If applying staging's schema would require any of these, the **whole promote is blocked** and none of it is applied:

- Dropping a column
- Dropping a table
- Changing a column's type
- Adding a `NOT NULL` constraint to an existing column

The refusal names the exact statements that are stuck, so you can apply them to production yourself if you genuinely intend them, then promote again.

This is all-or-nothing on purpose. If a promote contains one blocked statement and five safe ones, none of the six are applied — a half-applied schema change is worse than no change.

Note the difference between two things that look similar:

- **Adding a column that is `NOT NULL` with a default** is safe on a table that already has rows, so it counts as additive and promotes fine.
- **Making an existing column `NOT NULL`** can fail against production rows that are currently null, so it's blocked.

### Removals are ignored, not applied

If you drop a table or column in staging, promote **keeps** it in production. Preview lists these under `ignored_removals` as information — they never block the promote, and they are never applied. Removing something from production is a decision you make against production directly.

## Resetting staging

Reset throws away everything in staging and re-seeds it from production. Use it when staging has drifted somewhere you don't want to be.

```
manage_staging({ app_id: "app_abc123", action: "reset" })
```

Reset also brings staging's **schema** back in line with production. That means it can destroy things that exist only in staging — a table you added, a column you dropped, a constraint you tightened. The job reports exactly what it destroyed:

> Reset changed staging's schema to match production and, in doing so, destroyed 2 objects that existed only on staging or differed from production: dropped staging-only column "orders"."currency"; make "orders"."status" nullable to match production. Reset makes staging match production; production was not touched.

Reset is destructive to **staging only**. Production is never written to by a reset.

Your env var overrides survive a reset.

## Idle staging environments are paused

A staging app nobody has touched for 30 days is **paused**, not deleted — it stops serving traffic but its data stays put. Resume it from the Staging page whenever you need it again.

Deleting a staging environment is always a deliberate, manual decision.

## Limits and interactions

- **One staging environment per production app.**
- **Staging lives in production's region.** The link between the two is region-local.
- **You cannot move an app between regions while a staging link exists.** Unlink or delete the staging environment first, then move the app. This applies in both directions — you can't move the staging app away from its production app either.
- A staging app is a normal app for **billing purposes**: it has its own database and counts toward your plan's usage. The dashboard's Billing page shows staging and production usage separately.

## Unlinking

Unlinking breaks the connection between the two apps without deleting either one. The staging app stays exactly where it is — it just stops being *your app's staging environment*, and you can create a new one.

```bash
curl -X DELETE https://api.butterbase.ai/v1/apps/app_abc123/staging \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
```

To actually get rid of it, delete the staging app like any other app.

## Reference

### MCP tools

| Tool | Actions |
|---|---|
| `manage_staging` | `create`, `status`, `reset`, `get_env_overrides`, `set_env_overrides` |
| `promote_staging` | `preview`, `run` |

### REST endpoints

| Method | Path |
|---|---|
| `POST` | `/v1/apps/:app_id/staging` |
| `GET` | `/v1/apps/:app_id/staging` |
| `DELETE` | `/v1/apps/:app_id/staging` |
| `POST` | `/v1/apps/:app_id/staging/reset` |
| `GET` | `/v1/apps/:app_id/staging/promote/preview` |
| `POST` | `/v1/apps/:app_id/staging/promote` |
| `GET` | `/v1/apps/:app_id/staging/env-overrides` |
| `PUT` | `/v1/apps/:app_id/staging/env-overrides` |

Track any job with `GET /v1/clone-jobs/:job_id`.
