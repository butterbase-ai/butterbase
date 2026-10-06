---
title: Preview Deployments
description: A copy of your live app that you can safely break — with your real data — and push live when it's ready.
---

A preview deployment is a copy of your live app that you can safely break.

It has its own database, its own files, its own sign-ups, and its own URL — so nothing you do in a preview can reach the app your real users are using. When the change works, you push it live.

Think of it as a rehearsal space: same stage, same props, no audience.

:::note[This is a whole second app, not just a frontend deploy]
"Deploying your frontend" pushes new files to your existing app. A *preview deployment* is bigger than that — it's a second copy of everything, backend included. The two are unrelated.
:::

## What's in a preview

A preview starts as a copy of your live app, and that includes **your real data**:

- Every row in every table.
- Every account that has signed up, including their password — so people can sign in to the preview with the password they use on the live app.
- Every uploaded file.

:::caution[A preview holds a real copy of your users' data]
If your live app stores personal information, your preview now stores a second copy of it. Anyone you give access to the preview can read all of it. Treat it as carefully as you treat the real thing.
:::

### What deliberately doesn't come along

Some things are left behind on purpose, so a preview can't reach into the real world and do damage:

| Left behind | Why |
|---|---|
| The **values** of your secrets and API keys | A preview must never hold your live keys — otherwise a test checkout charges a real credit card. The key *names* are created but left **empty**, so anything that needs one fails loudly instead of quietly spending your money. Fill them in with [preview secrets](#preview-secrets). |
| Connected accounts (Stripe, Google, and so on) | Copied and then disconnected, so the preview can't act as you. Reconnect them on the preview if you need them. |
| Scheduled jobs and integrations | Switched **off**. A preview copy of your nightly billing job should not run. |
| Billing and analytics history | That history belongs to your live app. |

One more: uploaded files get new ids in the preview. If your app stores a file's id inside one of your own tables, that column still points at the live app's copy of the file.

## Creating a preview

You get **one** preview per app, and it's always created in the same place in the world as your live app.

**Just ask your AI assistant** — "create a preview deployment for this app" — or do it yourself:

**MCP**

```
manage_preview({ app_id: "app_abc123", action: "create" })
```

**REST**

```bash
curl -X POST https://api.butterbase.ai/v1/apps/app_abc123/staging \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
```

**Dashboard** — open your app and choose **Preview** in the sidebar.

Creating hands you back a `job_id`. Copying your data takes as long as your data needs it to, so this is **not instant**:

```
manage_preview({ app_id: "app_abc123", action: "status" })
```

Until that job says `completed`, you do not have a usable preview yet — it won't show up in `status` and it isn't connected to your app.

## Preview secrets

Your preview knows the *names* of your secrets but none of their *values*. Preview secrets are how you fill them in — usually with test credentials, so the preview talks to Stripe's test mode while your live app keeps the real key.

```
manage_preview({
  app_id: "app_abc123",
  action: "set_env_overrides",
  env_overrides: { PAYMENT_PROVIDER_KEY: "sk_test_..." }
})
```

Two things worth knowing:

- They're stored against your **live** app, so you can set them *before* you create the preview and it comes up already working. They also survive a reset, or deleting the preview and making a new one.
- Reading them back gives you the key **names** only, never the values. Nothing can read a secret back out.

Setting them replaces the whole set at once. Pass an empty object to clear them.

## Pushing a preview live

Pushing live copies your preview's **structure** onto your live app: your tables and fields, your access rules, your functions, your settings, and your code — and it deploys the frontend. This is a real deploy to your real app.

**Your live data stays exactly where it is.** Rows are never overwritten and never removed. If you added a table in the preview, pushing live creates that table on your live app — empty.

Always look before you leap:

```
promote_preview({ app_id: "app_abc123", action: "check" })
```

```json
{
  "can_promote": true,
  "additive": ["ALTER TABLE orders ADD COLUMN refunded_at timestamptz"],
  "blocked": [],
  "ignored_removals": []
}
```

`additive` is the list of changes that are safe to apply. If `blocked` is empty and `can_promote` is true, you're clear:

```
promote_preview({ app_id: "app_abc123", action: "run" })
```

### What gets blocked, and why

Butterbase will not let a push-live throw away your real users' data. If your change needs any of these, the **whole push is cancelled** and nothing at all is applied:

| What you changed in the preview | Why it's blocked |
|---|---|
| Deleted a field | Your live app has real values in it. Deleting the field throws them away. |
| Deleted a table | The same, for every row in it. |
| Changed a field's type — text to number, say | Existing values might not survive the conversion. |
| Made an existing field required | Live rows that are currently blank would break. |

It's all-or-nothing on purpose. If your change has one blocked piece and five safe ones, none of the six go through — an app that's half-updated is in worse shape than one that didn't update at all.

Butterbase names the exact change that's stuck. If you really do mean it, make that one change on your live app directly, then push again.

One pair that looks the same and isn't:

- **Adding a new field that's required, with a default value** is safe even when the table already has rows — every existing row gets the default. This goes through fine.
- **Making an existing field required** can fail against live rows that are blank right now. This is blocked.

### Deleting things is ignored, not applied

If you delete a table or a field in your preview, pushing live **keeps** it on your live app. The preview lists these under `ignored_removals` so you know about them — they never block the push, and they're never applied.

Deleting something from your live app is a decision you make against the live app directly, on purpose.

## Starting a preview over

Resetting throws away everything in the preview and copies it fresh from your live app. Use it when the preview has wandered somewhere you don't want to be.

```
manage_preview({ app_id: "app_abc123", action: "reset" })
```

Reset also puts the preview's **structure** back in line with your live app — which means it can destroy things that only ever existed in the preview: a table you added, a field you deleted, a rule you tightened. It tells you exactly what it destroyed:

> Reset changed the preview's structure to match your live app and, in doing so, destroyed 2 things that existed only on the preview or differed from it: dropped preview-only column "orders"."currency"; made "orders"."status" optional again to match. Reset makes the preview match your live app; your live app was not touched.

Reset only ever destroys things in the **preview**. Your live app is never written to by a reset.

Your preview secrets survive a reset.

## Previews you stop using get paused

A preview nobody has touched for 30 days is **paused**, not deleted — it stops serving traffic, but all its data stays put. Resume it from the Preview page whenever you want it back.

Actually deleting a preview is always something you do deliberately, by hand.

## What it costs, and what it counts against

- **Preview deployments need the Launch plan or above.** On the free Playground plan you'll see an upgrade prompt instead of a create button.
- **A preview counts as one project** against your plan's limit. On Launch (3 projects), your live app + its preview = 2 of 3, leaving room for one more app. If you're already at your limit, creating a preview fails and tells you so.
- **One preview per app.**
- **A preview lives in the same region as your live app**, and the link between them is region-local.
- **You can't move an app to another region while it has a preview.** Delete or disconnect the preview first, then move. This works both ways — you can't move the preview away from its app either.
- **A preview bills like a normal app.** It has its own database and its own usage, and it counts toward your plan. The dashboard's Billing page shows preview usage separately from your live app's.

## Disconnecting a preview

Disconnecting breaks the link between the two apps without deleting either one. The preview app stays exactly where it is — it just stops being *your app's preview*, and you're free to create a new one.

```bash
curl -X DELETE https://api.butterbase.ai/v1/apps/app_abc123/staging \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
```

To actually get rid of it, delete that app the way you'd delete any other app.

## Reference

The REST paths below still say `staging` — that's the internal name for the same thing, and they are unchanged.

### MCP tools

| Tool | Actions |
|---|---|
| `manage_preview` | `create`, `status`, `reset`, `get_env_overrides`, `set_env_overrides` |
| `promote_preview` | `check`, `run` |

:::caution[These tools were renamed]
They used to be `manage_staging` and `promote_staging`, and `promote`'s read-only action used to be called `preview`. The old names are gone — update any saved prompt or script that still calls them.
:::

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
