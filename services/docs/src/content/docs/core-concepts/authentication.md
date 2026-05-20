---
title: Authentication
description: Full auth service with email/password signup, OAuth providers, JWT tokens, and password reset.
---

Butterbase provides a complete authentication service for your app's end users. Each app has independent user accounts and tokens, scoped by `app_id`. End-user data lives in the same [region](/core-concepts/regions/) as the app it belongs to.

## Access modes

Each app has an `access_mode` that controls whether anonymous (unauthenticated) requests can reach the data API and realtime WebSocket. RLS policies still apply on top of this.

| Mode | Behavior |
|------|----------|
| `public` (default) | Anonymous requests allowed. RLS policies, if configured, still apply. |
| `authenticated` | Anonymous data and realtime requests are rejected with HTTP 401. Only end-user JWTs and API keys pass. |

`access_mode` does not affect function invocations or storage — those have their own auth rules.

### Toggle access mode

```json
PATCH /v1/{app_id}/config/access-mode
Authorization: Bearer {token}

{ "access_mode": "authenticated" }
```

Response:

```json
{
  "message": "Access mode updated to \"authenticated\"",
  "app_id": "app_abc123",
  "access_mode": "authenticated"
}
```

### Lock down in one call

`POST /v1/{app_id}/secure` is a composite shortcut: it sets `access_mode = "authenticated"` and, for every table you list, enables RLS with a user-isolation policy and an auto-populate trigger.

```json
POST /v1/{app_id}/secure
Authorization: Bearer {token}

{
  "tables": [
    { "table_name": "posts", "user_column": "author_id" },
    { "table_name": "comments", "user_column": "user_id" }
  ]
}
```

Pass `public_read_column` (a boolean column name) to additionally allow any user to read rows where it is `true`:

```json
{
  "tables": [
    { "table_name": "posts", "user_column": "author_id", "public_read_column": "is_published" }
  ]
}
```

Omit `tables` entirely to only flip `access_mode` without RLS changes.

Response includes `tables_secured` and a `table_errors` array — if a table is missing or a column doesn't exist, the call still succeeds for the other tables.

To revert: PATCH the access mode back to `"public"`.

## Signup

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/\{app_id}/signup | 5 requests per 15 minutes |

```json
{
  "email": "user@example.com",
  "password": "MyP@ssw0rd!",
  "display_name": "Jane Doe"
}
```

**Password requirements:** At least 8 characters, must include uppercase, lowercase, a number, and a special character.

A verification email is sent automatically with a 6-digit code.

## Login

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/\{app_id}/login | 10 requests per 15 minutes |

```json
{
  "email": "user@example.com",
  "password": "MyP@ssw0rd!"
}
```

**Response:**

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

The **access token** is what your frontend sends with API requests. The **refresh token** is used to get a new access token when the current one expires.

## Magic link sign-in

Passwordless sign-in: the user enters an email, receives a 6-digit code, and is signed in on verify. New users are auto-created (no separate signup step).

**Step 1: Send the code**

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/\{app_id}/magic-link | 5 requests per 15 minutes |

```json
{
  "email": "user@example.com"
}
```

The response is a generic message regardless of whether the email exists (prevents user enumeration). The code expires after **15 minutes**.

**Step 2: Verify the code**

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/\{app_id}/magic-link/verify | 10 requests per 15 minutes |

```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

Response is the same shape as `/login` — `access_token`, `refresh_token`, `expires_in`, `token_type`, and `user`. The user's email is marked verified automatically. Codes are single-use.

**Error responses (HTTP 400):**

| `error` | Cause |
|---------|-------|
| `Invalid sign-in code` | Code does not match |
| `Sign-in code already used` | Code was already exchanged |
| `Sign-in code expired` | 15-minute window passed |

**SDK:**

```ts
const { data, error } = await client.auth.sendMagicLink('user@example.com');
// later, after the user enters the code:
const { data, error } = await client.auth.verifyMagicLink('user@example.com', '123456');
```

`verifyMagicLink` persists the session automatically (same as `signIn`).

### Behavior notes

- **Frictionless signup:** if no user exists for the email, one is created automatically when the code is sent. The first verification logs them in.
- **`isNewUser` detection:** users who verified within 2 minutes of being created are flagged as new in audit logs and in the post-auth hook payload.
- **Post-auth hook:** verifying a code fires the configured hook with `event: "magic_link_login"` and `provider: "magic_link"` (see [Post-auth hooks](#post-auth-hooks)).
- **Audit events:** `magic_link_requested` (on send) and `magic_link_login` (on verify).

## Token refresh

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/\{app_id}/refresh | 20 requests per 15 minutes |

Exchange a refresh token for a new access token. The old refresh token is invalidated (token rotation).

```json
{
  "refresh_token": "your-refresh-token"
}
```

## Logout

| Method | Path | Auth Required |
|--------|------|---------------|
| POST | /auth/\{app_id}/logout | Yes (Bearer token) |

Revokes all refresh tokens. The user must log in again.

## Email verification

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/\{app_id}/verify-email | 10 requests per 15 minutes |

```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

The code expires after **24 hours**.

## Password reset

**Step 1: Request a reset code**

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/\{app_id}/forgot-password | 3 requests per 15 minutes |

Always returns success regardless of whether the email exists (prevents user enumeration).

**Step 2: Reset the password**

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/\{app_id}/reset-password | 5 requests per 15 minutes |

```json
{
  "email": "user@example.com",
  "code": "123456",
  "new_password": "NewP@ssw0rd!"
}
```

The reset code expires after **1 hour**. All existing sessions are invalidated.

## Social sign-in (OAuth)

Configure a provider using the `configure_oauth_provider` MCP tool or the [OAuth configuration API](/api-reference/auth-api).

### Built-in providers

These only need `client_id`, `client_secret`, and `redirect_uris` — URLs and default scopes are auto-filled:

| Provider | Default Scopes |
|----------|---------------|
| **google** | openid, email, profile |
| **github** | user:email |
| **discord** | identify, email |
| **facebook** | email, public_profile |
| **linkedin** | openid, profile, email |
| **microsoft** | openid, email, profile, User.Read |
| **apple** | name, email (requires `provider_metadata`) |
| **x** | tweet.read, users.read (no email; synthetic email used) |

Custom providers require `authorization_url`, `token_url`, and `userinfo_url`.

### OAuth flow

1. Direct the user's browser to `/auth/{app_id}/oauth/{provider}?redirect_to=https://yourapp.com/callback`
2. The user signs in with the provider
3. The provider redirects to the callback URL
4. Tokens are returned as query parameters: `?access_token=...&refresh_token=...&expires_in=900`

### Provider-specific notes

- **Google, LinkedIn, Apple:** User info extracted from ID token via JWKS.
- **GitHub:** If email is not public, it's fetched from /user/emails automatically.
- **Apple:** Uses POST callback (form_post). Requires `provider_metadata` with teamId, keyId, and privateKey. Only provides name on first authorization.
- **X (Twitter):** Uses PKCE. No email provided — a synthetic email is generated.

## User profile

| Method | Path | Auth Required |
|--------|------|---------------|
| GET | /auth/\{app_id}/me | Yes |

Returns the authenticated user's profile.

## Token verification (JWKS)

| Method | Path | Cache |
|--------|------|-------|
| GET | /auth/\{app_id}/.well-known/jwks.json | 5 minutes |

Returns public keys for verifying access tokens in your own backend.

## Using tokens with the Data API

Include the access token when calling the data API:

```
GET /v1/{app_id}/posts
Authorization: Bearer {access_token}
```

With RLS enabled, the user only sees their own rows automatically.

## Post-auth hooks

Run custom logic after any successful authentication event (OAuth login, email login, email signup). The hook is a regular Butterbase function that is invoked fire-and-forget — it never delays token delivery to the user.

### Configuring

Use the `configure_auth_hook` MCP tool or the API:

```json
PATCH /v1/{app_id}/config/auth-hooks
Authorization: Bearer {token}

{
  "post_auth_function": "on-auth"
}
```

Set `post_auth_function` to `null` to remove the hook. The function must be deployed before it can be configured as a hook.

### Hook payload

The hook function receives a POST request with this JSON body:

```json
{
  "event": "oauth_login",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "provider": "google",
    "display_name": "Jane Doe",
    "avatar_url": "https://..."
  },
  "isNewUser": true,
  "provider": "google"
}
```

| Field | Values |
|-------|--------|
| `event` | `"oauth_login"`, `"signup"`, `"login"` |
| `isNewUser` | `true` for first-time users, `false` for returning users |
| `provider` | `"google"`, `"github"`, `"email"`, etc. |

### Example hook function

```typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const { event, user, isNewUser } = await req.json();

  if (isNewUser) {
    // Send welcome email
    ctx.waitUntil(
      fetch("https://api.email.com/send", {
        method: "POST",
        body: JSON.stringify({ to: user.email, template: "welcome" }),
      })
    );

    // Sync profile to your own table
    await ctx.db.query(
      "INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)",
      [user.id, user.display_name]
    );
  }

  return new Response("ok");
}
```

The hook runs as `butterbase_service` (RLS bypassed). `ctx.user` is null — use the payload body to identify the user.

## Token lifetimes

Configurable per app using `update_jwt_config`:

- **Access token:** Default `1h` (options: `15m`, `30m`, `1h`, `2h`, `1d`)
- **Refresh token:** Default 7 days (configurable in days)

The 1-hour default is chosen so that cookie-based sessions in SSR apps don't fail silently when the JWT expires inside the cookie's lifetime. If you want stricter rotation, lower it with `update_jwt_config({ access_token_ttl: '15m' })` and make sure your client refreshes proactively before the cookie outlives the token.
