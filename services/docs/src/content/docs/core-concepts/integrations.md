---
title: Integrations
description: Connect third-party services to your Butterbase app. Let your end-users authorize Gmail, Google Calendar, Slack, GitHub, and more — then execute actions on their behalf.
---

Integrations let your app's users connect their external accounts (Gmail, Slack, GitHub, etc.) and grant your app permission to act on their behalf. Butterbase manages the OAuth flow for you — no OAuth server, no token storage, no refresh logic.

## How it works

1. **Configure** — You (the app developer) enable a toolkit for your app. Butterbase creates an OAuth configuration on your behalf.
2. **Connect** — Your end-user clicks a connect button. Your app calls the connect endpoint, gets a redirect URL, and sends the user there. The OAuth handshake is handled for you.
3. **Execute** — Once connected, your app calls the execute endpoint with a tool name and parameters. Butterbase forwards the call using the user's stored credentials.

## Curated integrations

These toolkits have first-class support and are pre-verified:

| Toolkit | Slug | Use cases |
|---------|------|-----------|
| Gmail | `gmail` | Send emails, read inbox, manage labels |
| Google Calendar | `google-calendar` | Create events, list upcoming meetings |
| Slack | `slack` | Send messages, create channels, manage users |
| Google Sheets | `google-sheets` | Read and write spreadsheet data |
| Notion | `notion` | Create pages, search, update databases |
| GitHub | `github` | Create issues, open PRs, read repos |
| HubSpot | `hubspot` | Manage contacts, deals, companies |
| Outlook | `outlook` | Send emails, manage calendar |
| Google Drive | `google-drive` | Upload, download, list files |
| Discord | `discord` | Send messages, manage servers |

You can also search the full integration catalog (1000+ toolkits) via `GET /v1/:appId/integrations/available?search=<query>`.

## Configuring an integration (admin)

Enable a toolkit for your app. Requires an API key:

```json
POST /v1/:appId/integrations/configure
{
  "toolkit": "gmail",
  "displayName": "Gmail",
  "scopes": []
}
```

Response:
```json
{
  "id": "uuid",
  "app_id": "app_abc123",
  "toolkit_slug": "gmail",
  "enabled": true
}
```

To disable: `DELETE /v1/:appId/integrations/configure/:toolkit`

## Connecting an end-user account

Your app calls the connect endpoint with a redirect URL. The user is sent to the OAuth authorization page:

```json
POST /v1/:appId/integrations/connect
Authorization: Bearer <user-jwt>
{
  "toolkit": "gmail",
  "redirectUrl": "https://yourapp.com/settings?tab=integrations"
}
```

Response:
```json
{
  "authUrl": "https://accounts.google.com/...",
  "connectionRequestId": "ca_xxx"
}
```

Redirect the user to `authUrl`. After they authorize, they are redirected back to your `redirectUrl` with `?status=connected&toolkit=gmail`.

:::note
The OAuth callback is handled entirely by Butterbase. You do not need to set up a callback route in your application.
:::

## Executing tools

Once a user has connected their account, you can execute any tool for that toolkit:

```json
POST /v1/:appId/integrations/execute
Authorization: Bearer <user-jwt>
{
  "toolName": "GMAIL_SEND_EMAIL",
  "params": {
    "to": "user@example.com",
    "subject": "Hello from my app",
    "body": "This was sent via Butterbase integrations."
  }
}
```

Response:
```json
{
  "successful": true,
  "data": { "messageId": "msg_xxx" }
}
```

To list available tools for a toolkit:

```
GET /v1/:appId/integrations/tools?toolkit=gmail
```

## Using integrations in functions

The `ctx.integrations` object is injected into every Butterbase function:

```typescript
export default async function handler(ctx) {
  // Execute a tool on behalf of the calling user
  const result = await ctx.integrations.execute('GMAIL_SEND_EMAIL', {
    to: ctx.body.email,
    subject: 'Welcome!',
    body: 'Thanks for signing up.',
  });

  // Execute as a specific user (e.g. in a cron job)
  const events = await ctx.integrations.asUser(userId).execute(
    'GOOGLECALENDAR_EVENTS_LIST',
    { timeMin: new Date().toISOString() }
  );

  return { ok: true };
}
```

**Authentication.** `ctx.integrations` is auto-wired with a per-app function key.
It can only call `/integrations/execute` for the app it was injected into, and
it always runs as a service caller — so `.asUser(userId)` is required when you
need an end-user's connection (cron jobs, scheduled syncs, webhook handlers).
The bare `ctx.integrations.execute(...)` form only works when the function was
invoked with an end-user JWT, because it relies on the request's auth context
to resolve the connection.

## SDK

```typescript
import { Butterbase } from '@butterbase/sdk';
const bb = new Butterbase({ appId: 'app_xxx', apiKey: 'bb_sk_...' });

// Admin: configure a toolkit
await bb.integrations.configure('slack');

// Get configured integrations
const { data } = await bb.integrations.getConfig();

// User: generate OAuth connect URL
const { data: result } = await bb.integrations.connect('slack', {
  redirectUrl: 'https://yourapp.com/connected',
});
window.location.href = result.authUrl;

// Execute a tool (JWT auth)
const { data } = await bb.integrations.execute('SLACK_SEND_MESSAGE', {
  channel: '#general',
  text: 'Hello from my app',
});

// Service-level execution on behalf of a user
const { data } = await bb.integrations.asUser(userId).execute(
  'GMAIL_SEND_EMAIL',
  { to: 'user@example.com', subject: 'Hi', body: 'Hello' }
);
```

## Managing connections

```
GET /v1/:appId/integrations/connections          — list connected accounts
DELETE /v1/:appId/integrations/connections/:id   — disconnect an account
```

Users only see their own connections. API key callers see all connections for the app.
