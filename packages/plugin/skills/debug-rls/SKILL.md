---
name: debug-rls
description: Use when users report access denied errors, see wrong data, RLS policies are not working, or when troubleshooting Row-Level Security issues in Butterbase
---

# debug-rls

Systematic methodology for debugging Row-Level Security issues in Butterbase. Uses role simulation (`as_role`/`as_user` parameters) to verify policy behavior without needing real user sessions.

---

## 1. Overview

Row-Level Security (RLS) in Butterbase controls which rows each database role can see or modify. When RLS is misconfigured, users may see no data, too much data, or get unexpected errors on insert. This skill walks through a repeatable four-step process to identify and fix the root cause.

Key principle: **MCP tools default to the service key (`bb_sk_...`), which bypasses all RLS**. Always use `as_role`/`as_user` to simulate the role your frontend actually uses.

---

## 2. Quick Diagnosis

Match the symptom your user reports to the most likely cause before diving into the full protocol.

| Symptom | Likely cause |
|---------|-------------|
| User sees no rows | RLS enabled but no policy for `butterbase_user` role |
| User sees ALL rows | RLS not enabled on the table, or request uses service key (`bb_sk_`) |
| Insert fails with `AUTH_RLS_POLICY_VIOLATION` | No INSERT policy, or `user_column` not auto-populated |
| User sees other users' data | Policy USING expression is wrong, or user isolation not set up |
| Anonymous user gets 403 | No policy for `butterbase_anon` role |
| Works in MCP tools but not from frontend | MCP uses service key (bypasses RLS); frontend uses end-user JWT |

---

## 3. The Three Roles

Butterbase automatically assigns a database role based on the auth header of each request. You never create these roles — they are built in.

| Auth header | Database role | Behavior |
|-------------|--------------|----------|
| None | `butterbase_anon` | Default deny. Only sees rows allowed by explicit anon policies. |
| Valid end-user JWT | `butterbase_user` | `current_user_id()` returns their UUID. Sees rows matching their policies. |
| API key (`bb_sk_...`) | `butterbase_service` | Bypasses ALL RLS. Sees everything. Used by MCP tools and admin operations. |

**Important:** When you call `select_rows` or `insert_row` without `as_role`, you are always running as `butterbase_service`. This means the result tells you nothing about what a real user would see. Use `as_role` to simulate the correct role.

---

## 4. Four-Step Debugging Protocol

Work through these steps in order. Each step narrows down the cause.

---

### Step 1: Check if RLS is enabled

Call `get_rls_policies` with the `app_id`:

```
get_rls_policies(app_id: "app_abc123")
```

- Look for the table in the response.
- If the table has **no policies**, RLS might not be enabled at all — or it was enabled but no policies were added, which causes a default deny for all non-service roles.
- If the table **does** appear, move to Step 2 to inspect what the policies actually do.

> A table with RLS enabled but zero policies is inaccessible to `butterbase_anon` and `butterbase_user`. The `butterbase_service` role is unaffected.

---

### Step 2: Inspect existing policies

Read each policy's fields carefully:

| Field | What it means |
|-------|--------------|
| `policyname` | Human-readable name for the policy |
| `cmd` | Which SQL command it applies to: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, or `ALL` |
| `qual` | The `USING` expression — filters which rows are visible or affected |
| `with_check` | The `WITH CHECK` expression — validates new/updated row data on write |
| `roles` | Which database role(s) this policy applies to |

**Common issues to look for:**

- Policy exists for `butterbase_user` but **not** `butterbase_anon` (anonymous users blocked)
- Policy exists for `SELECT` but **not** `INSERT` (reads work, writes fail)
- `USING` expression references the wrong column (e.g., `owner_id` instead of `user_id`)
- Policy covers `ALL` commands but the `WITH CHECK` expression is missing (inserts may fail silently)

---

### Step 3: Test as different roles

Use the `as_role` and `as_user` parameters on `select_rows` and `insert_row` to simulate each role. **This is the most direct way to reproduce what a real user experiences.**

```
# Test SELECT as an authenticated user
select_rows(
  app_id: "app_abc123",
  table: "posts",
  as_role: "user",
  as_user: "user-uuid-here"
)

# Test SELECT as anonymous
select_rows(
  app_id: "app_abc123",
  table: "posts",
  as_role: "anon"
)

# Test INSERT as an authenticated user
insert_row(
  app_id: "app_abc123",
  table: "posts",
  data: { title: "Hello" },
  as_role: "user",
  as_user: "user-uuid-here"
)
```

Compare results between roles:

| Scenario | Expected result |
|----------|----------------|
| No `as_role` (service) | All rows returned, inserts succeed — RLS bypassed |
| `as_role: "user"` | Only the user's own rows (if isolation policy exists) |
| `as_role: "anon"` | Only publicly readable rows (if anon policy exists), or empty |

If results differ from expectations, you have confirmed which role/command combination is misconfigured.

> Without `as_role`, MCP tools always use the service key and bypass RLS. Never use this to validate that RLS is working.

---

### Step 4: Check auto-populate trigger

This step specifically diagnoses `AUTH_RLS_POLICY_VIOLATION` on INSERT.

1. Insert a row as a user (using `as_role: "user"`):

```
insert_row(
  app_id: "app_abc123",
  table: "posts",
  data: { title: "Test post" },
  as_role: "user",
  as_user: "user-uuid-here"
)
```

2. Check if the `user_id` / `author_id` column was **auto-populated** in the returned row.

3. If the column is `NULL` or missing from the response, **the auto-populate trigger is missing**. The RLS policy requires `user_id = current_user_id()`, but the column was never filled in, so the WITH CHECK fails.

**Root cause:** `enable_rls` + `create_policy` (without `user_column`) does **not** install an auto-populate trigger. Clients would need to manually include the user column in every POST body — which most frontends don't do.

**Fix:** See Fix 1 or Fix 3 in the next section.

---

## 5. Common Fixes

Four ready-to-use recipes. Copy the MCP tool call that matches your situation.

---

### Fix 1: Enable basic user isolation

Use this when a table has no RLS at all and you want users to only see their own rows.

```
create_user_isolation_policy(
  app_id: "app_abc123",
  table_name: "posts",
  user_column: "author_id"
)
```

**What this creates automatically:**

- RLS enabled on the table
- User isolation policy: `author_id = current_user_id()::uuid` for ALL commands
- Auto-populate trigger: sets `author_id` from the JWT on INSERT (clients don't need to send it)
- Service bypass policy: `butterbase_service` can still read/write all rows

This is the recommended starting point for any user-owned data table.

---

### Fix 2: Add public read access

Use this when you want anonymous users (or all authenticated users) to be able to read certain rows — for example, published blog posts or public profiles.

```
create_policy(
  app_id: "app_abc123",
  table_name: "posts",
  policy_name: "public_read_published",
  command: "SELECT",
  role: "anon",
  using_expression: "published = true"
)
```

This lets anonymous users read posts where `published = true`. They still cannot read unpublished posts or write anything.

> To also allow authenticated (non-anonymous) users to read public rows, add a second policy with `role: "user"` and the same `using_expression`.

Alternatively, if you haven't set up user isolation yet, you can use the shorthand in `create_user_isolation_policy`:

```
create_user_isolation_policy(
  app_id: "app_abc123",
  table_name: "posts",
  user_column: "author_id",
  public_read_column: "published"
)
```

This sets up user isolation **and** public read access in a single call.

---

### Fix 3: Fix missing auto-populate trigger

Use this when inserts fail with `AUTH_RLS_POLICY_VIOLATION` and the user column is NULL after insert (diagnosed in Step 4).

**Option A — Recommended: Replace with `create_user_isolation_policy`**

This is the cleanest fix if you're starting fresh or can replace the existing policy:

```
create_user_isolation_policy(
  app_id: "app_abc123",
  table_name: "posts",
  user_column: "author_id"
)
```

Always includes the auto-populate trigger. No manual step needed.

**Option B — Additive: Add trigger to existing setup via `create_policy` with `user_column`**

Use this when you want to keep existing policies but just add the trigger:

```
create_policy(
  app_id: "app_abc123",
  table_name: "posts",
  policy_name: "posts_user_insert",
  command: "INSERT",
  role: "user",
  with_check_expression: "author_id = current_user_id()::uuid",
  user_column: "author_id"
)
```

Passing `user_column` to `create_policy` installs the auto-populate trigger alongside the policy.

> **Without the trigger:** clients must include the user column (`author_id`, `user_id`, etc.) in every POST body. Most frontends don't do this, causing all inserts to fail with RLS violations.

---

### Fix 4: Add cross-table restrictive check

Use this when you need to enforce a condition that involves another table — for example, only allowing comments on published posts.

```
create_policy(
  app_id: "app_abc123",
  table_name: "comments",
  policy_name: "comments_on_public_posts_only",
  command: "INSERT",
  role: "user",
  with_check_expression: "EXISTS (SELECT 1 FROM posts WHERE posts.id = post_id AND posts.published = true)",
  restrictive: true
)
```

**Why `restrictive: true`?**

A RESTRICTIVE policy is AND'd with all permissive policies. Without it, if the user isolation policy already passes (because `user_id = current_user_id()`), the cross-table check would never be evaluated — users could comment on private posts.

Setting `restrictive: true` ensures this check runs in addition to any permissive policies, so both conditions must be satisfied.

> Use RESTRICTIVE policies sparingly — only when a condition must never be bypassed by another policy.

---

## 6. Expression Reference

### Helper functions

| Expression | Returns | Used in |
|-----------|---------|---------|
| `current_user_id()` | Authenticated user's UUID as text | USING, WITH CHECK |
| `current_user_id()::uuid` | Same, cast to UUID type | When `user_column` is UUID type |

Use `current_user_id()` (text) when your user column is `TEXT`. Use `current_user_id()::uuid` when your user column is `UUID`. Mismatched types cause silent policy failures.

---

### Policy clauses

| Clause | Purpose | Used for commands |
|--------|---------|-------------------|
| `USING` | Filter which rows are visible or affected by the operation | SELECT, UPDATE, DELETE, ALL |
| `WITH CHECK` | Validate that new or updated row data satisfies the expression | INSERT, UPDATE, ALL |

For `ALL` command policies, both `USING` and `WITH CHECK` may apply:
- On SELECT/DELETE: only `USING` is evaluated
- On INSERT: only `WITH CHECK` is evaluated
- On UPDATE: both are evaluated (USING for old row, WITH CHECK for new row)

---

### Policy permissiveness

| Policy type | Behavior |
|-------------|----------|
| PERMISSIVE (default) | Multiple permissive policies are OR'd — any one passing grants access |
| RESTRICTIVE | AND'd with permissive policies — must pass in addition to at least one permissive |

**Example:** If a table has two permissive policies (user isolation + public read), a row is visible if **either** passes. If you add a restrictive policy, the row is only visible if the restrictive condition **also** passes.

---

## 7. Verification Checklist

After applying any fix, run through this checklist to confirm correct behavior:

- [ ] `get_rls_policies` shows the expected policies for the table
- [ ] `select_rows` with `as_role: "user"` returns only the user's own rows
- [ ] `select_rows` with `as_role: "anon"` returns only publicly visible rows (or empty if no anon policy)
- [ ] `select_rows` without `as_role` (service) returns all rows (confirms RLS is only blocking end-users, not admin)
- [ ] `insert_row` with `as_role: "user"` succeeds and the user column is auto-populated
- [ ] `insert_row` with `as_role: "anon"` fails (unless you explicitly added an anon INSERT policy)
- [ ] `select_rows` with `as_role: "user"` for **a different user's UUID** does not return the first user's rows

---

## 8. Anti-Patterns to Avoid

| Anti-pattern | Problem | Fix |
|-------------|---------|-----|
| Using `select_rows` without `as_role` to verify RLS | Service key bypasses RLS — result is meaningless for verification | Always use `as_role: "user"` or `as_role: "anon"` |
| `enable_rls` + `create_policy` without `user_column` | No auto-populate trigger; clients must send user column manually | Use `create_user_isolation_policy` or pass `user_column` to `create_policy` |
| Single policy with `cmd: "ALL"` but no `WITH CHECK` | INSERT/UPDATE may silently pass or fail depending on expression | Explicitly provide `with_check_expression` for write commands |
| Relying on `butterbase_service` policies for end-user access | Service bypass is always on; end-users use `butterbase_user` or `butterbase_anon` | Write separate policies for each end-user role |
| Missing policy for one role while having it for another | Authenticated users may see data that anonymous users cannot, or vice versa — may be intentional but often a bug | Audit all roles with `get_rls_policies` |
