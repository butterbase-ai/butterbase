---
title: Integrations API
description: REST endpoints for configuring integrations, managing OAuth connections, and executing third-party tools.
sidebar:
  order: 9
---

All integration endpoints require authentication. Admin endpoints (configure, disable, list config) require an API key (`Authorization: Bearer bb_sk_...`). End-user endpoints (connect, execute, connections) accept either a user JWT or an API key with a `userId` body field.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/v1/:appId/integrations/available` | API key | List curated toolkits or search catalog |
| `GET` | `/v1/:appId/integrations/config` | API key | List enabled integrations |
| `POST` | `/v1/:appId/integrations/configure` | API key | Enable a toolkit |
| `DELETE` | `/v1/:appId/integrations/configure/:toolkit` | API key | Disable a toolkit |
| `POST` | `/v1/:appId/integrations/connect` | JWT or API key + userId | Generate OAuth URL for end-user |
| `GET` | `/v1/:appId/integrations/callback` | Public | OAuth callback handler |
| `GET` | `/v1/:appId/integrations/connections` | JWT or API key | List connected accounts |
| `DELETE` | `/v1/:appId/integrations/connections/:id` | JWT or API key | Disconnect an account |
| `GET` | `/v1/:appId/integrations/tools` | JWT or API key | List available tools |
| `POST` | `/v1/:appId/integrations/execute` | JWT or API key + userId | Execute a tool |

## GET /v1/:appId/integrations/available

List the 10 curated toolkits, or search the full catalog with `?search=`.

```
GET /v1/app_abc/integrations/available?search=salesforce
```

Response:
```json
{
  "integrations": [
    { "toolkit": "salesforce", "displayName": "Salesforce", "curated": false }
  ]
}
```

## POST /v1/:appId/integrations/configure

Enable a toolkit for the app.

```json
{
  "toolkit": "gmail",
  "displayName": "Gmail",
  "scopes": []
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `toolkit` | string | ✓ | Toolkit slug (e.g. `gmail`, `google-calendar`) |
| `displayName` | string | | Human-readable name shown in the dashboard |
| `scopes` | string[] | | OAuth scopes (defaults to platform-managed) |

## POST /v1/:appId/integrations/connect

Generate an OAuth URL for an end-user. Redirect the user to `authUrl`.

```json
{
  "toolkit": "gmail",
  "redirectUrl": "https://yourapp.com/settings",
  "userId": "uuid"
}
```

`userId` is required when authenticating with an API key. Omit when using a user JWT.

Response:
```json
{
  "authUrl": "https://accounts.google.com/...",
  "connectionRequestId": "ca_xxx"
}
```

## POST /v1/:appId/integrations/execute

Execute a tool using the authenticated user's connected account.

```json
{
  "toolName": "GMAIL_SEND_EMAIL",
  "params": { "to": "x@y.com", "subject": "Hi", "body": "Hello" },
  "userId": "uuid"
}
```

`userId` is required when using an API key. Omit when using a user JWT.

Response on success:
```json
{ "successful": true, "data": { ... } }
```

Response on failure (`422` soft failure, `502` network error):
```json
{
  "error": {
    "code": "INTEGRATIONS_EXECUTION_FAILED",
    "message": "...",
    "remediation": "Check the tool name and parameters. Ensure the user has a connected account."
  }
}
```

## Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `INTEGRATIONS_NOT_CONFIGURED` | 400 | Integration service not configured on the platform |
| `INTEGRATIONS_TOOLKIT_NOT_ENABLED` | 400 | Toolkit not enabled for this app — call `/configure` first |
| `INTEGRATIONS_EXECUTION_FAILED` | 422/502 | Tool execution failed (422 = soft failure, 502 = network error) |
