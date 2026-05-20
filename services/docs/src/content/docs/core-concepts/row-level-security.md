---
title: Row-Level Security
description: Restrict data access so each user only sees their own rows using PostgreSQL RLS policies.
---

Row-Level Security (RLS) lets you control which rows each user can access. It's powered by PostgreSQL's built-in RLS mechanism and enforced automatically based on how requests are authenticated.

## Built-in roles

Butterbase has three built-in roles that are **automatically determined** by the Authorization header. You never create or configure these roles:

| Request type | Authorization header | Role assigned |
|---|---|---|
| No auth header | (none) | butterbase_anon |
| End-user JWT | `Bearer {end_user_jwt}` | butterbase_user |
| Platform API key | `Bearer {platform_api_key}` | butterbase_service |

**butterbase_anon** — Access to public data only (based on your policies). Use for product catalogs, public profiles.

**butterbase_user** — Access to user-specific data. `current_user_id()` returns the authenticated user's ID. Use for dashboards, personal data.

**butterbase_service** — Full access to all data (bypasses RLS). A service bypass policy is auto-created on every RLS-enabled table.

## Three tools for RLS

### 1. enable_rls — Foundation

Enable RLS on a table. The service bypass policy is auto-created.

```
enable_rls({ app_id: "app_abc123", table_name: "posts" })
```

### 2. create_user_isolation_policy — Simple

One-call setup for the common case: users see only their own data.

```
create_user_isolation_policy({
  app_id: "app_abc123",
  table_name: "posts",
  user_column: "user_id"
})
```

This automatically:
- Enables RLS
- Creates a user isolation policy (scoped to butterbase_user)
- Adds a trigger to auto-populate the user column on INSERT
- Creates a service bypass policy

### 3. create_policy — Power user

Full control over USING and WITH CHECK expressions:

```
create_policy({
  app_id: "app_abc123",
  table_name: "products",
  policy_name: "public_read_products",
  command: "SELECT",
  role: "anon",
  using_expression: "active = true AND published = true"
})
```

**Expression rules by command:**

| Command | USING | WITH CHECK |
|---------|-------|------------|
| SELECT | Yes | No |
| INSERT | No | Yes |
| UPDATE | Both | Both |
| DELETE | Yes | No |
| ALL | Both | Both |

## Policy examples

### Public read access (anonymous users)

```
create_policy({
  policy_name: "public_read_products",
  command: "SELECT",
  role: "anon",
  using_expression: "active = true AND published = true"
})
```

### User-specific access (authenticated users)

Quick way:
```
create_user_isolation_policy({
  table_name: "orders",
  user_column: "user_id"
})
```

Custom way:
```
create_policy({
  policy_name: "users_own_orders",
  command: "ALL",
  role: "user",
  using_expression: "user_id = current_user_id()"
})
```

### INSERT policy (user can only insert their own rows)

```
create_policy({
  policy_name: "users_insert_own",
  command: "INSERT",
  role: "user",
  with_check_expression: "user_id = current_user_id()::uuid"
})
```

### Mixed access (public read, user write)

1. Enable RLS: `enable_rls({ table_name: "products" })`
2. Public read: `create_policy({ command: "SELECT", role: "anon", using_expression: "active = true" })`
3. Authenticated write: `create_policy({ command: "INSERT", role: "user", with_check_expression: "user_id = current_user_id()" })`

## Role scoping

Always use the `role` parameter to prevent cross-role policy leaks:
- `role: "anon"` — Policy applies only to unauthenticated requests
- `role: "user"` — Policy applies only to authenticated end-users

Without role scoping, a policy applies to ALL roles, which can expose data unintentionally.

## Helper functions

- **current_user_id()** — Returns the authenticated user's ID as TEXT. Cast to UUID if needed: `current_user_id()::uuid`. Returns NULL for anonymous users.

## Auto-populate trigger

Only `create_user_isolation_policy` and `create_policy` with the `user_column` parameter create a BEFORE INSERT trigger that auto-fills the user column. Without the trigger, clients must include the user column in POST bodies.

## Common pitfall: Cross-table subqueries

When a RESTRICTIVE policy contains a subquery that reads another table, that subquery runs under the same user's RLS context. If the other table has user isolation, the subquery can only see the current user's rows.

**Example:** User B tries to comment on User A's public post. The policy on comments checks `EXISTS(SELECT 1 FROM posts WHERE id = post_id AND is_public = true)`. But posts has user isolation, so User B can't see User A's posts — the insert is blocked.

**Solution:** Add a permissive SELECT policy on the referenced table for all authenticated users. Or use `create_user_isolation_policy` with `public_read_column: "is_public"`.

## REST API

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/rls/enable | Enable RLS on a table |
| POST | /v1/\{app_id}/rls/policies | Create a custom RLS policy |
| POST | /v1/\{app_id}/rls | Quick user isolation setup |
| GET | /v1/\{app_id}/rls | List all active policies |
| DELETE | /v1/\{app_id}/rls/\{table} | Remove RLS from a table |
