---
title: Database & Schema
description: Define your database schema declaratively — Butterbase diffs and applies only the changes needed.
---

Butterbase uses a declarative JSON format to define your database schema. You describe the desired state; the platform figures out what changes are needed and applies them safely.

Each app's database lives in the [region](/core-concepts/regions/) you picked when you created the app. You can move it to another region later if your audience shifts.

## Basic structure

```json
{
  "schema": {
    "tables": {
      "table_name": {
        "columns": {
          "column_name": {
            "type": "text",
            "primary": true,
            "nullable": false,
            "unique": true,
            "default": "gen_random_uuid()",
            "references": { "table": "other_table", "column": "id" }
          }
        },
        "indexes": {
          "idx_name": {
            "columns": ["col1", "col2"],
            "unique": false
          }
        }
      }
    }
  },
  "dry_run": false,
  "name": "descriptive migration name"
}
```

## Column properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `type` | string | Yes | The column data type |
| `primary` | boolean | No | Makes this column the primary key |
| `nullable` | boolean | No | Whether NULL values are allowed (default: true) |
| `unique` | boolean | No | Adds a unique constraint |
| `default` | string | No | Default value expression (e.g., `"now()"`, `"gen_random_uuid()"`) |
| `references` | string \| object | No | Foreign key. Either `"table.column"` shorthand or `{table, column, onDelete?, onUpdate?}`. |

## Supported column types

| Category | Types |
|----------|-------|
| **Text** | `text`, `varchar`, `varchar(N)`, `char`, `char(N)` |
| **Numbers** | `integer`, `bigint`, `smallint`, `real`, `float4`, `float8`, `decimal`, `numeric`, `numeric(P,S)` |
| **Boolean** | `boolean`, `bool` |
| **UUID** | `uuid` |
| **Date/Time** | `timestamp`, `timestamptz`, `date`, `time`, `timetz`, `interval` |
| **JSON** | `json`, `jsonb` |
| **Binary** | `bytea` |
| **Vectors** | `vector(N)` where N is the dimension (for AI embeddings) |
| **Arrays** | `text[]`, `integer[]`, etc. |

## Common patterns

### Basic table with auto-generated ID

```json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "title": { "type": "text", "nullable": false },
        "body": { "type": "text" },
        "published": { "type": "boolean", "default": "false" },
        "created_at": { "type": "timestamptz", "default": "now()" },
        "updated_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
```

### Table with foreign key and user ownership

```json
{
  "tables": {
    "comments": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "post_id": { "type": "uuid", "nullable": false, "references": { "table": "posts", "column": "id", "onDelete": "CASCADE" } },
        "user_id": { "type": "uuid", "nullable": false },
        "body": { "type": "text", "nullable": false },
        "created_at": { "type": "timestamptz", "default": "now()" }
      },
      "indexes": {
        "idx_comments_post": { "columns": ["post_id"] },
        "idx_comments_user": { "columns": ["user_id"] }
      }
    }
  }
}
```

After creating this table, use `create_user_isolation_policy` with `table_name: "comments"` and `user_column: "user_id"` for per-user data isolation.

### Foreign keys with referential actions

The `references` field accepts two equivalent forms.

**String shorthand** — defaults `onDelete` and `onUpdate` to `NO ACTION`:

```json
"author_id": { "type": "uuid", "references": "users.id" }
```

**Object form** — explicit referential actions:

```json
"author_id": {
  "type": "uuid",
  "references": {
    "table": "users",
    "column": "id",
    "onDelete": "CASCADE",
    "onUpdate": "NO ACTION"
  }
}
```

**Allowed action values** for both `onDelete` and `onUpdate`:

| Value | Effect when the referenced row is deleted/updated |
|-------|---------------------------------------------------|
| `NO ACTION` (default) | Block the operation if dependent rows exist (deferred) |
| `RESTRICT` | Block immediately, no deferral |
| `CASCADE` | Apply the same operation to dependent rows |
| `SET NULL` | Set the FK column to NULL (column must be nullable) |
| `SET DEFAULT` | Set the FK column to its declared default |

Common pattern — delete a user and cascade-delete their posts:

```json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "author_id": {
          "type": "uuid",
          "nullable": false,
          "references": { "table": "users", "column": "id", "onDelete": "CASCADE" }
        },
        "title": { "type": "text", "nullable": false }
      }
    }
  }
}
```

### Table with vector column (for AI embeddings)

```json
{
  "tables": {
    "documents": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "content": { "type": "text" },
        "embedding": { "type": "vector(1536)" },
        "created_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
```

## Adding columns to existing tables

Include the existing table with both existing and new columns. The platform diffs and only applies the changes:

```json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "title": { "type": "text", "nullable": false },
        "body": { "type": "text" },
        "published": { "type": "boolean", "default": "false" },
        "image_url": { "type": "text" },
        "view_count": { "type": "integer", "default": "0" },
        "created_at": { "type": "timestamptz", "default": "now()" },
        "updated_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
```

This adds `image_url` and `view_count` without touching existing columns.

## Dropping columns

Explicitly list columns to remove in `_dropColumns`:

```json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "title": { "type": "text", "nullable": false },
        "body": { "type": "text" },
        "created_at": { "type": "timestamptz", "default": "now()" }
      },
      "_dropColumns": ["published", "image_url"]
    }
  }
}
```

## Dropping tables

Set `_drop: true` to remove an entire table:

```json
{
  "tables": {
    "old_table": {
      "_drop": true
    }
  }
}
```

## Marking tables as seed data

Use `_seed: true` to mark a table as containing seed data — rows that should be included when your app is cloned as a template:

```json
{
  "tables": {
    "roles": {
      "_seed": true,
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "name": { "type": "text", "nullable": false, "unique": true },
        "created_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
```

The marker persists across schema apply/introspect cycles. Use it on lookup tables, reference data, default roles, or example rows so your templates are ready when they need them.

**Note:** Currently the marker is forward-compatible only — it does not yet trigger automatic row copying during template clone. That capability will arrive in a future release. Mark your seed tables now to prepare for when row copying becomes active.

## Dry run (preview changes)

Always preview before applying destructive changes:

```json
{
  "schema": { "tables": { "..." : {} } },
  "dry_run": true
}
```

The response includes the SQL statements that would run, without actually executing them. Review the output, then apply with `dry_run: false` (or omit it).

## Auto-generated Data API

Once tables exist, a full REST API is automatically available — no code generation needed. See [REST API](/sdks-and-tools/rest-api) for the complete reference.

## Safety

- **Destructive operations are blocked by default.** You must explicitly use `_drop` or `_dropColumns` to remove tables or columns.
- **Schema limit:** Maximum 50 tables per schema definition.
- **Idempotent:** Applying the same schema twice does nothing — only differences are applied.

## Database architecture

Each app gets its own isolated PostgreSQL database (`app_{id}`) on the data plane. Every app database is initialized with:

- `pgvector` extension for embeddings
- `uuid-ossp` extension for UUID generation
- `current_user_id()` function for RLS support
- Schema migration tracking
