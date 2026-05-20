---
title: REST API
description: Full REST API reference for the auto-generated data API, filtering, sorting, and pagination.
---

Once you create tables through the schema tools, a full REST API is automatically available. No code generation or route setup needed.

**Placeholders:**
- `{app_id}` — Your app's identifier
- `{table}` — A table name in your schema
- `{id}` — A row's primary key value

## Data API

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/\{app_id}/\{table} | List rows with filtering, sorting, pagination |
| GET | /v1/\{app_id}/\{table}/\{id} | Read a single row by primary key |
| POST | /v1/\{app_id}/\{table} | Create a row |
| PATCH | /v1/\{app_id}/\{table}/\{id} | Update a row (partial) |
| DELETE | /v1/\{app_id}/\{table}/\{id} | Delete a row |

## Filtering

Add query parameters in the format `column=operator.value`:

| Operator | Example | Meaning |
|----------|---------|---------|
| `eq` | `status=eq.published` | Equals |
| `neq` | `status=neq.draft` | Not equals |
| `gt` | `age=gt.18` | Greater than |
| `gte` | `age=gte.18` | Greater than or equal |
| `lt` | `price=lt.100` | Less than |
| `lte` | `price=lte.100` | Less than or equal |
| `like` | `title=like.%hello%` | Pattern match (case-sensitive) |
| `ilike` | `title=ilike.%hello%` | Pattern match (case-insensitive) |
| `is` | `deleted_at=is.null` | IS NULL, IS TRUE, IS FALSE |
| `in` | `id=in.(1,2,3)` | In a list of values |
| `fts` | `title=fts.hello world` | Full-text search (English, with stemming) |

## Sorting

Use the `order` parameter:

```
?order=created_at.desc
?order=name.asc,created_at.desc
```

## Pagination

Use `limit` and `offset`:

```
?limit=20&offset=40
```

Returns rows 41-60.

## Column selection

Use the `select` parameter:

```
?select=id,title,created_at
```

## Example

```
GET /v1/{app_id}/posts?select=id,title,author_id&status=eq.published&order=created_at.desc&limit=20
```

## Authentication

The role is determined automatically by the Authorization header:

| Request type | Authorization header | Role |
|---|---|---|
| No auth header | (none) | butterbase_anon |
| End-user JWT | `Bearer {jwt}` | butterbase_user |
| Platform API key | `Bearer {api_key}` | butterbase_service |

See [Row-Level Security](/core-concepts/row-level-security) for how these roles interact with data access policies.

## Schema endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/\{app_id}/schema | Read current schema |
| POST | /v1/\{app_id}/schema/apply | Apply a schema update |
| GET | /v1/\{app_id}/migrations | List applied migrations |

## App management

| Method | Path | Purpose |
|--------|------|---------|
| GET | /apps | List your apps |
| POST | /init | Create a new app (accepts optional `region`) |
| DELETE | /apps/\{app_id} | Delete an app |
| GET | /v1/regions | List supported regions (public, no auth) |
| POST | /v1/apps/\{app_id}/move | Move an app to another region |
| GET | /v1/apps/\{app_id}/migrations/\{migration_id} | Check move progress |

See [Regions](/core-concepts/regions/) and the [Platform API reference](/api-reference/platform-api/#apps--regions) for request and response shapes.

## Health checks

| Method | Path | Purpose |
|--------|------|---------|
| GET | /health | Liveness check |
| GET | /health/ready | Readiness check (verifies database) |

## Error responses

Errors include structured objects with `code`, `message`, and `remediation` fields:

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Table 'nonexistent' does not exist",
    "remediation": "Check the table name and ensure it exists in your schema"
  }
}
```

For complete endpoint references, see the [API Reference](/api-reference/data-api) section.
