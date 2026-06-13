---
title: Regions
description: Choose where your app's data and compute live — close to your users, with one API URL that works everywhere.
---

When you create an app on Butterbase, you choose a region. Your database, files, and serverless functions live in that region — close to the users you're serving. Your client code keeps using a single API URL; we handle the routing automatically.

## Available regions

| Region | Code |
|---|---|
| US East | `us-east-1` |
| US West | `us-west-2` |

More regions are coming soon. If you'd like one in a specific part of the world, [let us know](mailto:hello@butterbase.ai).

### Fetching the live list

The supported region list is always available from the API. Use this if you're building a UI that lets your users choose a region, or if you want to validate a region slug before calling `init_app` or `manage_app` (action: `"move"`).

**MCP**

```
list_regions()
```

**REST**

```bash
curl https://api.butterbase.ai/v1/regions
# → { "regions": ["us-east-1", "us-west-2"] }
```

This endpoint is public (no API key required).

## Picking a region when you create an app

Region is optional. If you don't specify one, your app is created in the default region.

**MCP**

```
init_app({ name: "my-app", region: "us-west-2" })
```

**CLI**

```bash
butterbase apps create my-app --region us-west-2
```

**REST**

```bash
curl -X POST https://api.butterbase.ai/init \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "region": "us-west-2"}'
```

## What lives in a region

Each app has a home region. The following stay there:

- Your database
- Your serverless functions
- Your file storage
- Your end users' accounts and sessions

The following are global and unaffected by region choice:

- The API URL — `https://api.butterbase.ai` works from anywhere
- Frontend deployments — served from a global edge network
- Your Butterbase account, billing, and the dashboard

## One URL, anywhere

Your frontend and SDK code always point at `https://api.butterbase.ai`. You don't pin to a regional URL, and you don't change anything when you move an app between regions. Requests are routed to the right region for you.

## Moving an app to another region

If your audience shifts — or you want to be closer to a different part of the world — you can move an app to another region.

**MCP**

```
manage_app({ action: "move", app_id: "app_abc123", dest_region: "us-east-1" })
```

**CLI**

```bash
butterbase apps move app_abc123 --to us-east-1
```

While the move is in progress, your app stays available for reads. Writes pause briefly during the cutover and resume automatically once the move completes. The whole process typically takes a few minutes, depending on how much data your app has.

Check progress at any time:

```
manage_app({ action: "move_status", app_id: "app_abc123", migration_id: "<id from move>" })
```

You can't move an app while another move is already in progress for it.

## Choosing a region

A few things to consider:

- **Where your users are.** Pick the region closest to most of them. Round-trip latency between users and the database is the single biggest factor in how fast your app feels.
- **Data residency.** If you need to keep data in a specific jurisdiction, pick a region in that jurisdiction. Reach out if you need a region we don't list yet.
- **You can change your mind.** Apps aren't locked to their initial region. If you outgrow your first choice, move the app.

If you're not sure, leave the region unset and Butterbase picks a sensible default. You can always move the app later.
