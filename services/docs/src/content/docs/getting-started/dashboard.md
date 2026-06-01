---
title: Dashboard
description: Manage your Butterbase apps through the web-based management UI.
---

The Butterbase dashboard at [dashboard.butterbase.ai](https://dashboard.butterbase.ai) gives you a visual interface to manage all aspects of your backend.

## Platform pages

| Page | What it does |
|------|-------------|
| **Apps** | View, create, and manage all your backend apps |
| **API Keys** | Generate and manage `bb_sk_` API keys for programmatic access |
| **Billing** | View your plan, usage metrics, and upgrade options |
| **Settings** | Account settings and developer mode toggle |
| **Templates** | Browse public app templates and clone any of them into a new app you own |

On the Apps page, you'll also find a "Clone template" button for users who already know a source `app_id` — use it to clone without browsing the Templates page.

## App management

When you select an app, you get access to these sections:

| Section | What it does |
|---------|-------------|
| **Overview** | App ID, API base URL, and quick-start information |
| **Schema** | Visual schema editor — view and modify tables, columns, types, and constraints |
| **Data** | Data browser — view, insert, edit, and delete rows in your tables |
| **Users** | Manage end-user accounts, view profiles, and monitor sign-ups |
| **OAuth** | Configure social sign-in providers (Google, GitHub, Discord, etc.) |
| **RLS** | View and manage row-level security policies on your tables |
| **Functions** | Deploy, view, and manage serverless functions with logs and metrics |
| **Deployments** | View frontend deployment history and manage live deployments |
| **Realtime** | Configure real-time WebSocket notifications on tables |
| **AI** | Configure AI model gateway settings and view usage |
| **Storage** | Browse uploaded files, view metadata, and manage storage |
| **Monetization** | Set up Stripe Connect, manage subscription plans and products |
| **Audit** | View authentication event logs (logins, signups, password resets) |
| **App Settings** | CORS configuration, JWT token lifetimes, and app-level settings |

## Developer mode

The dashboard has a developer mode toggle in Settings. When enabled, you get access to the Apps page and full app management features. When disabled, you see a simplified view focused on billing and account settings.

## Connecting to the docs

You can access these docs at any time from the **Documentation** link in the dashboard sidebar, or directly at [docs.butterbase.ai](https://docs.butterbase.ai).
