---
title: Data API
description: Complete reference for the auto-generated CRUD REST API.
sidebar:
  order: 1
---

Once tables exist in your schema, these endpoints are automatically available.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/\{app_id}/\{table} | List rows |
| GET | /v1/\{app_id}/\{table}/\{id} | Read single row |
| POST | /v1/\{app_id}/\{table} | Create a row |
| PATCH | /v1/\{app_id}/\{table}/\{id} | Update a row |
| DELETE | /v1/\{app_id}/\{table}/\{id} | Delete a row |

## Query parameters

### Filtering

Format: `column=operator.value`

| Operator | Example | SQL |
|----------|---------|-----|
| `eq` | `status=eq.published` | `= 'published'` |
| `neq` | `status=neq.draft` | `!= 'draft'` |
| `gt` | `age=gt.18` | `> 18` |
| `gte` | `age=gte.18` | `>= 18` |
| `lt` | `price=lt.100` | `< 100` |
| `lte` | `price=lte.100` | `<= 100` |
| `like` | `title=like.%hello%` | `LIKE '%hello%'` |
| `ilike` | `title=ilike.%hello%` | `ILIKE '%hello%'` |
| `is` | `deleted_at=is.null` | `IS NULL` |
| `in` | `id=in.(1,2,3)` | `IN (1,2,3)` |
| `fts` | `title=fts.hello` | Full-text search |

### Sorting

```
?order=created_at.desc
?order=name.asc,created_at.desc
```

### Pagination

```
?limit=20&offset=40
```

### Column selection

```
?select=id,title,created_at
```

## Authentication

| Auth method | Role | Access |
|---|---|---|
| None | butterbase_anon | Public data only |
| End-user JWT | butterbase_user | User-scoped data (RLS) |
| API key (`bb_sk_...`) | butterbase_service | All data (bypasses RLS) |

## Create a row

```bash
POST /v1/{app_id}/posts
Content-Type: application/json
Authorization: Bearer {token}

{
  "title": "Hello World",
  "body": "My first post",
  "published": true
}
```

If the table has a user isolation policy with auto-populate trigger, the `user_id` column is filled automatically.

## Update a row

```bash
PATCH /v1/{app_id}/posts/{id}
Content-Type: application/json
Authorization: Bearer {token}

{
  "published": false
}
```

Only send columns you want to change.

## Delete a row

```bash
DELETE /v1/{app_id}/posts/{id}
Authorization: Bearer {token}
```

## Schema endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/\{app_id}/schema | Read current schema |
| POST | /v1/\{app_id}/schema/apply | Apply schema update (`dry_run: true` to preview) |
| GET | /v1/\{app_id}/migrations | List applied migrations |

## App management

| Method | Path | Purpose |
|--------|------|---------|
| GET | /apps | List your apps |
| POST | /init | Create a new app. Body: `{"name": "my-app"}` |
| DELETE | /apps/\{app_id} | Delete an app permanently |
