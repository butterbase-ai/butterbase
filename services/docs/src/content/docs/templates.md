---
title: Templates
description: Clone any public Butterbase app into a running backend of your own in under a minute.
---

A **template** is a public Butterbase app that anyone can clone. Cloning gives you a brand-new app you own outright — schema, security policies, functions, Durable Objects, and source files already in place, running on a live backend in the region you pick.

This is not a starter repo. There is no "now wire up your database" step. The clone comes up provisioned, migrated, and deployable.

Two first-party templates are published today — a full AI-native CRM and an AI support desk. See **[Available Templates](/templates/available/)**.

## Why start from a template

**You skip the boring 80%.** Auth wiring, table design, RLS policies, function scaffolding, storage buckets, CORS — the parts every app needs and nobody enjoys writing — arrive already done and already working together.

**You start from something that ran.** A template isn't a snapshot of someone's aspirations. It's a copy of an app that was actually deployed, with the schema that actually served traffic.

**You own it completely.** The clone is your app, in your organization, on your plan, in your region. There is no upstream dependency, no license check, no phone-home. The publisher can delete their app tomorrow and yours keeps running.

**Nothing of the publisher's leaks to you, and nothing of yours leaks to them.** Secrets are the hard line: API keys, OAuth client secrets, and BYOK credentials never cross. You see the *names* of the environment variables a template needs so you know exactly what to fill in — never the values.

**The tedious bits get filled in for you.** Butterbase resolves `BUTTERBASE_API_URL` and `BUTTERBASE_APP_ID` to your new app automatically, and can mint a fresh scoped API key for `BUTTERBASE_API_KEY` so the cloned functions can talk to their own backend on the first invocation.

**You know what you're signing up for before you clone.** A preflight call lists every environment variable the template's functions and Durable Objects expect, and marks each one as auto-filled or "you must supply this."

**It works from wherever you work.** The dashboard, the CLI, the REST API, and any MCP-connected AI agent all drive the same clone pipeline.

## What you get in a clone

| Copied | Not copied |
|---|---|
| Database schema — tables, columns, indexes | End-user accounts and sessions |
| Row-level security policies | OAuth **client secrets** |
| Serverless function code | Function environment variable **values** |
| Durable Object classes | BYOK AI provider keys |
| Repo files (latest pushed snapshot) | [Custom domains](/core-concepts/custom-domains/) |
| The published frontend, re-pointed at your app | — |
| Non-secret config — storage settings, CORS, OAuth providers and redirect URLs, AI model defaults | Billing and Stripe Connect setup |
| App-level environment variables | Invocation history and audit logs |
| Rows in tables the publisher marked `_seed: true` | Invocation history and audit logs |

Full detail in [Configuring Your Clone](/templates/configure/).

## How a clone runs

Cloning is asynchronous. You get a `job_id` back immediately and poll it. The job walks these stages, so a status read tells you exactly where it is:

`pending` → `processing` → `replaying_schema` → `replaying_rls` → `replaying_durable_objects` → `replaying_functions` → `replaying_config` → `copying_repo` → `seeding_data` → `completed`

A failed job reports `error_message` and can be retried. A successful job can still return `warnings[]` — soft failures worth reading, like an auth hook that couldn't be rebound.

## Limits

| Limit | Value |
|---|---|
| Clones started per user | 5 per hour |
| Concurrent in-flight clones per user | 3 |
| Source requirements | `visibility: public` **and** at least one `butterbase repo push` |
| Quota | Each clone is a new app and counts against your plan's project limit |
| Name uniqueness | App names are globally unique — a taken name returns `409` |

## Where to go next

- **[Available Templates](/templates/available/)** — the live catalog, with a page for each template
- **[Cloning a Template](/templates/cloning/)** — find one and clone it, from the dashboard, CLI, MCP, or API
- **[Configuring Your Clone](/templates/configure/)** — the post-clone checklist that takes it from "cloned" to "live"
- **[Publishing a Template](/templates/publishing/)** — turn one of your apps into a template others can clone
