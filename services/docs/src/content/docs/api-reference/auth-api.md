---
title: Auth API
description: Complete reference for authentication endpoints.
sidebar:
  order: 2
---

All auth routes are scoped by `{app_id}`. Each app has independent user accounts and tokens.

## Endpoints

| Method | Path | Rate Limit | Purpose |
|--------|------|------------|---------|
| POST | /auth/\{app_id}/signup | 5/15min | Register a new user |
| POST | /auth/\{app_id}/login | 10/15min | Sign in |
| POST | /auth/\{app_id}/magic-link | 5/15min | Send a 6-digit sign-in code by email |
| POST | /auth/\{app_id}/magic-link/verify | 10/15min | Exchange a code for tokens |
| POST | /auth/\{app_id}/refresh | 20/15min | Refresh access token |
| POST | /auth/\{app_id}/logout | Auth required | End session |
| POST | /auth/\{app_id}/verify-email | 10/15min | Verify email with code |
| POST | /auth/\{app_id}/forgot-password | 3/15min | Request reset code |
| POST | /auth/\{app_id}/reset-password | 5/15min | Reset password |
| GET | /auth/\{app_id}/me | Auth required | Get current user profile |
| GET | /auth/\{app_id}/.well-known/jwks.json | Cached 5min | Public keys for token verification |

## OAuth endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /auth/\{app_id}/oauth/\{provider}?redirect_to=\{url} | Start OAuth flow |
| GET | /auth/\{app_id}/oauth/\{provider}/callback | OAuth callback |
| POST | /auth/\{app_id}/oauth/\{provider}/callback | POST callback (Apple) |

## OAuth configuration

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/auth/oauth-config | Register a provider |
| GET | /v1/\{app_id}/auth/oauth-config | List all providers |
| GET | /v1/\{app_id}/auth/oauth-config/\{provider} | Get provider config |
| PATCH | /v1/\{app_id}/auth/oauth-config/\{provider} | Update a provider |
| DELETE | /v1/\{app_id}/auth/oauth-config/\{provider} | Remove a provider |

### Register a provider

```json
POST /v1/{app_id}/auth/oauth-config

{
  "provider": "google",
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_CLIENT_SECRET",
  "redirect_uris": ["https://api.example.com/auth/app_yourid/oauth/google/callback"]
}
```

**Built-in providers** (only need `provider`, `client_id`, `client_secret`, `redirect_uris`):
google, github, discord, facebook, linkedin, microsoft, apple, x

**Custom providers** also need: `authorization_url`, `token_url`, `userinfo_url`

### Apple provider

Requires `provider_metadata`:

```json
{
  "provider": "apple",
  "client_id": "com.example.app",
  "client_secret": "placeholder",
  "redirect_uris": ["https://api.example.com/auth/app_yourid/oauth/apple/callback"],
  "provider_metadata": {
    "teamId": "ABCDE12345",
    "keyId": "KEY123",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n..."
  }
}
```

## Request/response examples

### Signup

```json
POST /auth/{app_id}/signup

{
  "email": "user@example.com",
  "password": "MyP@ssw0rd!",
  "display_name": "Jane Doe"
}
```

**Password requirements:** 8+ characters, uppercase, lowercase, number, special character.

### Login response

```json
{
  "access_token": "eyJhbGciOi...",
  "refresh_token": "...",
  "expires_in": 3600,
  "token_type": "Bearer",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "email_verified": true,
    "display_name": "Jane Doe",
    "avatar_url": null
  }
}
```

### Magic-link send

```json
POST /auth/{app_id}/magic-link

{ "email": "user@example.com" }
```

Response is identical whether or not the email exists (prevents enumeration):

```json
{ "message": "If an account exists with that email, a sign-in code has been sent" }
```

Codes expire after **15 minutes** and are single-use. New users are auto-created on first verify.

### Magic-link verify

```json
POST /auth/{app_id}/magic-link/verify

{ "email": "user@example.com", "code": "123456" }
```

Response shape is identical to the login response. Failure responses are HTTP 400 with one of: `Invalid sign-in code`, `Sign-in code already used`, `Sign-in code expired`.

## App configuration

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/\{app_id}/config | Read full app config |
| PATCH | /v1/\{app_id}/config/cors | Update CORS origins |
| PATCH | /v1/\{app_id}/config/jwt | Update token lifetimes |
| PATCH | /v1/\{app_id}/config/pause | Pause / resume the app (kill-switch). Body: `{ paused: boolean, reason?: string }`. While paused, all data-plane traffic returns 503 with `code: APP_PAUSED`. Auth and control-plane endpoints stay reachable. |

## Audit logs

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/\{app_id}/audit-logs | Query auth events. Filters: `user_id`, `event_type`, `limit`, `offset` |
