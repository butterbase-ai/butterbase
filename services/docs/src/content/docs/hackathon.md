---
title: Hackathon
description: Submit your Butterbase project during an active hackathon using MCP, scoring, and the dashboard.
---

When Butterbase runs a hackathon, you register with a code from the organizers, submit your project through the **`prep_and_submit_hackathon_entry`** MCP tool, and review your entry in the [dashboard](https://dashboard.butterbase.ai/hackathon).

## Before you submit

1. **Connect MCP** — Follow [MCP Setup](/getting-started/mcp-setup) so your assistant can call Butterbase tools with your API key.
2. **Get a submission code** — Organizers share a per-hackathon code (for example after you sign up). You need it on your **first** successful submission so your account is bound to that hackathon. The same code is also used during prep to identify which open hackathon you mean when more than one is running.
3. **Know your `app_id`** (recommended) — Use **`manage_app`** with `action: "list"` and copy the `id` of the app you are entering (for example `app_abc123`). See [Why include app_id](#why-include-app_id) below.

## Submitting with MCP

The tool **`prep_and_submit_hackathon_entry`** appears in your MCP tool list whenever some hackathon row has `starts_at ≤ now ≤ submission_deadline`. Calendar `ends_at` is separate from submissions closing at **`submission_deadline`**.

The flow is **two steps**: **prep** to resolve the hackathon and discover its fields, then **submit** with the confirmed values.

### Step 1 — `action: "prep"`

Pass your **`submission_code`**. The tool resolves which open hackathon you mean and returns:

- **`matched`** — `{ slug, name, submission_deadline, ends_at, field_schema }` describing the hackathon and its fields.
- **`open_hackathons`** — every hackathon currently accepting submissions, in case `matched` is `null` and you need to disambiguate.
- **`next_call`** — a fully-formed example **`submit`** invocation, including a placeholder for every field in `field_schema`. Use this as the literal shape for Step 2 — replace each placeholder in `arguments.data` with the user-confirmed value.

If `matched` is `null` and `open_hackathons` has multiple entries, ask the user which hackathon and re-run prep with the right `submission_code`.

### Step 2 — `action: "submit"`

Send:

- **`hackathon_slug`** — use **`matched.slug`** from the prep response so submit targets exactly the hackathon prep resolved.
- **`data`** — an object whose keys match each `field_schema` field's `key`. Easiest path: take `next_call.arguments.data` from prep and fill in each placeholder. A JSON-encoded string is also accepted and will be parsed.
- **`app_id`** — strongly recommended; see [Why include app_id](#why-include-app_id).
- **`submission_code`** — required only on the **first** submission so you can be bound as a participant. After that you are bound by user id and the code is no longer required.

### If `data` is missing

If you call `submit` without `data`, the tool **does not just error**. It re-resolves the hackathon and returns the field schema plus another **`next_call`** template so you have an exact shape to retry with — no extra round trip needed.

### Updates

Submissions **upsert**: calling submit again with new `data` updates your entry and bumps **`version`**.

## Why include `app_id`

Pass **`app_id`** (the Butterbase app you built) on every submission when you can.

**Automated leaderboard scoring** works like this:

- Up to **50** points for a valid **demo URL** hosted on **`*.butterbase.dev`**. The hackathon schema may mark one field with **`is_url`** for this check; otherwise the **`demo_url`** key in **`data`** is used.
- Up to **50** additional points for **Butterbase features** detected on the app tied to **`app_id`** (database, functions, deployed frontend, auth users, storage, OAuth, realtime, integrations, and more).

If **`app_id`** is omitted, only the demo URL is scored; the feature portion is **zero**, so your total is usually much lower than comparable entries that linked an app.

**Human judges** can also verify your real project faster when the submission is linked to a concrete app.

## View your submission

Open **[dashboard.butterbase.ai/hackathon](https://dashboard.butterbase.ai/hackathon)** while signed in. You will see deadlines, your submitted fields (read-only), and the current **version**. Use MCP again to update the entry.

## Related

- [MCP Setup](/getting-started/mcp-setup) — connect your assistant.
- [MCP Tools](/api-reference/mcp-tools) — full tool list, including hackathon tools when the window is open.
