---
title: Clone from a template
description: Browse public Butterbase apps and clone one as the starting point for your own.
---

Butterbase lets you clone any public app as a starting point for your own project. The clone copies the source's database schema, functions, and code files — you get a complete, working app you can immediately customize.

## From the dashboard

The easiest way to find and clone a template is through the dashboard:

1. Go to [dashboard.butterbase.ai](https://dashboard.butterbase.ai) and select the **Templates** page.
2. Search or scroll to find a template you like. Each card shows the app name, owner, schema summary, and number of times it's been cloned.
3. Click the template card to see full details — tables, functions, and recent clones.
4. Click **Clone** to start the process. You'll be prompted to name your app and choose a region.
5. Once the clone completes, you're redirected to your new app's overview page.

## From the CLI

Clone from the command line using the app ID:

```bash
butterbase templates --sort popular
butterbase clone <app_id> ./my-clone [--name "My App Name"] [--region us-west-2]
```

The `clone` command:

1. Creates a new app (you own it).
2. Pulls the source's latest repo snapshot into `./my-clone/` (defaults to a dir named after the app id).
3. Updates `.butterbase/config.json` with the new app ID.

Both `--name` and `--region` are optional. If omitted, the new app gets a default name and inherits the source's region.

## From an MCP agent

Two steps using the MCP `manage_app` tool:

**Step 1:** Search for public templates.

```
manage_app action: "find_templates"
  q: "blog"
  sort: "popular"
  limit: 10
```

Returns `{ items: [...], total, limit, offset }` with matching templates.

**Step 2:** Start the clone.

```
manage_app action: "clone"
  source_app_id: "<app_id>"
  name: "My Custom Name"
  region: "us-west-2"
```

Returns `{ job_id, status: "pending" }`.

**Step 3:** Poll until done.

```
manage_app action: "get_clone_job"
  job_id: "<job_id>"
```

Returns `status` (`pending`, `completed`, or `failed`), `dest_app_id` when completed, and `error_message` on failure.

## After the clone — what to set up yourself

Once your clone is ready, you'll need to configure:

- **OAuth client secrets** — update provider credentials if your clone uses social sign-in.
- **Function environment variables** — functions run with no env vars; you must add them via the dashboard or `manage_function` action.
- **BYOK AI keys** — if the source used bring-your-own keys for Claude, Gemini, or other models, add your own via app settings.
- **Custom domains** — if you want a custom domain, configure it on the cloned app (separate from the source).

For the full inventory of what transfers, see [What a clone copies](/core-concepts/database#what-a-clone-copies). For what doesn't, see [What stays with you](/core-concepts/database#what-stays-with-you).

## Clone job warnings

The clone API returns a `warnings[]` array to report deviations during replay. For example:

- If the source's `auth_hook_function` points to a function that couldn't be replayed, the binding is left NULL and a warning is printed.
- Storage or function settings that reference secrets don't copy (those secrets belong to the source owner).

Both the dashboard, CLI, and MCP tools surface these warnings. Review them after the clone completes to ensure your new app is configured correctly.
