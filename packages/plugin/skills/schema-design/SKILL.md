---
name: schema-design
description: Use when designing database schemas, creating or modifying tables, choosing column types, adding indexes, or working with the Butterbase declarative schema DSL
---

# Schema Design Skill

Reference guide for Butterbase's declarative schema DSL. Covers column types, constraints, indexes, and common data modeling patterns.

---

## 1. Overview

Butterbase uses a **declarative schema DSL** — you describe the desired end state of your database, and the platform computes and applies the diff. You never write raw `ALTER TABLE` or `CREATE TABLE` SQL. Instead, call `apply_schema` with a JSON payload describing your tables, columns, and indexes.

Key principles:
- **Idempotent**: applying the same schema twice is safe
- **Additive by default**: new columns and tables are created automatically
- **Explicit drops**: destructive operations require opt-in via `_drop` / `_dropColumns`
- **Preview first**: use `dry_run_schema` to see what will change before committing

---

## 2. Column Types Reference

| Type | PostgreSQL | Use case |
|------|-----------|----------|
| `uuid` | UUID | Primary keys, foreign keys |
| `text` | TEXT | Strings of any length |
| `integer` | INTEGER | Whole numbers (-2B to 2B) |
| `bigint` | BIGINT | Large whole numbers |
| `boolean` | BOOLEAN | True/false flags |
| `timestamptz` | TIMESTAMPTZ | Dates with timezone |
| `jsonb` | JSONB | Structured/semi-structured data |
| `real` | REAL | 32-bit floating point |
| `double precision` | DOUBLE PRECISION | 64-bit floating point |
| `vector(N)` | VECTOR(N) | Embeddings (pgvector) |

> **Always use `timestamptz` instead of `timestamp`.** `timestamp` silently drops timezone info and causes subtle bugs with users in different time zones.

---

## 3. Column Properties

Each column is an object with the following properties:

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `type` | string | ✅ yes | — | Column data type (see §2) |
| `primaryKey` | boolean | no | false | Mark as primary key |
| `nullable` | boolean | no | true | Allow NULL values |
| `default` | string | no | — | SQL expression for default value |
| `unique` | boolean | no | false | Add unique constraint |
| `references` | string | no | — | Foreign key target: `"table.column"` |

### Default expressions

Pass SQL expressions as strings:

```json
"default": "gen_random_uuid()"   // UUID primary keys
"default": "now()"               // Timestamps
"default": "false"               // Booleans
"default": "0"                   // Integers
"default": "'draft'"             // String literals (single-quoted)
```

### Foreign keys

```json
"author_id": {
  "type": "uuid",
  "nullable": false,
  "references": "users.id"
}
```

---

## 4. Standard Base Pattern

Every table should include these base columns:

```json
{
  "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
  "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
  "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
}
```

If your app uses Row-Level Security (RLS), also add:

```json
"user_id": { "type": "uuid", "nullable": false, "references": "users.id" }
```

> Tables without `user_id` cannot have per-user RLS policies applied later without a migration.

---

## 5. Index Types

| Type | Use case | Example opclass |
|------|----------|----------------|
| `btree` | Default, range queries, sorting | — |
| `hash` | Exact-match lookups | — |
| `gin` | Full-text search on JSONB, arrays | `jsonb_path_ops` |
| `gist` | Geometric/spatial data | — |
| `hnsw` | Vector similarity (pgvector) | `vector_cosine_ops` |
| `ivfflat` | Vector similarity (large datasets) | `vector_cosine_ops` |

### Index definition format

Indexes are defined per-table under the `indexes` key:

```json
{
  "indexes": {
    "idx_posts_author": {
      "columns": ["author_id"],
      "type": "btree"
    },
    "idx_posts_embedding": {
      "columns": ["embedding"],
      "type": "hnsw",
      "opclass": "vector_cosine_ops"
    },
    "idx_posts_content_search": {
      "columns": ["content"],
      "type": "gin"
    }
  }
}
```

Index naming convention: `idx_{table}_{column(s)}` — e.g. `idx_orders_user_id`.

### Composite indexes

```json
"idx_members_workspace_user": {
  "columns": ["workspace_id", "user_id"],
  "type": "btree",
  "unique": true
}
```

---

## 6. Using `apply_schema`

### Creating new tables

Simply include the table definition in your schema payload. The platform creates it if it does not exist.

### Adding columns to existing tables

Add the new column(s) to the existing table definition and call `apply_schema`. Existing rows receive the column's `default` value (or NULL if no default).

### Destructive operations

Dropping tables and columns is opt-in and explicit:

```json
{
  "schema": {
    "_drop": ["old_table_name", "another_old_table"]
  }
}
```

Dropping columns from a specific table:

```json
{
  "schema": {
    "posts": {
      "_dropColumns": ["legacy_field", "unused_col"],
      "columns": { ... }
    }
  }
}
```

> ⚠️ Drops are irreversible. Always run `dry_run_schema` first.

### Preview with `dry_run_schema`

Use the same payload with `dry_run_schema` to see a diff of what will be created, altered, or dropped — without touching the database:

```json
// Same payload, different tool:
// dry_run_schema({ appId, schema }) — preview only
// apply_schema({ appId, schema })  — commits changes
```

---

## 7. Complete Patterns

### A) Blog / CMS

```json
{
  "appId": "YOUR_APP_ID",
  "schema": {
    "users": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "email": { "type": "text", "nullable": false, "unique": true },
        "name": { "type": "text", "nullable": false },
        "avatar_url": { "type": "text" },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_users_email": { "columns": ["email"], "type": "btree", "unique": true }
      }
    },
    "categories": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "name": { "type": "text", "nullable": false, "unique": true },
        "slug": { "type": "text", "nullable": false, "unique": true },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      }
    },
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "author_id": { "type": "uuid", "nullable": false, "references": "users.id" },
        "category_id": { "type": "uuid", "references": "categories.id" },
        "title": { "type": "text", "nullable": false },
        "slug": { "type": "text", "nullable": false, "unique": true },
        "content": { "type": "text" },
        "excerpt": { "type": "text" },
        "published": { "type": "boolean", "nullable": false, "default": "false" },
        "published_at": { "type": "timestamptz" },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_posts_author_id": { "columns": ["author_id"], "type": "btree" },
        "idx_posts_category_id": { "columns": ["category_id"], "type": "btree" },
        "idx_posts_slug": { "columns": ["slug"], "type": "btree", "unique": true },
        "idx_posts_published": { "columns": ["published", "published_at"], "type": "btree" }
      }
    },
    "comments": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "post_id": { "type": "uuid", "nullable": false, "references": "posts.id" },
        "author_id": { "type": "uuid", "nullable": false, "references": "users.id" },
        "content": { "type": "text", "nullable": false },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_comments_post_id": { "columns": ["post_id"], "type": "btree" },
        "idx_comments_author_id": { "columns": ["author_id"], "type": "btree" }
      }
    }
  }
}
```

---

### B) E-commerce

```json
{
  "appId": "YOUR_APP_ID",
  "schema": {
    "products": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "name": { "type": "text", "nullable": false },
        "description": { "type": "text" },
        "price": { "type": "integer", "nullable": false },
        "stock": { "type": "integer", "nullable": false, "default": "0" },
        "sku": { "type": "text", "unique": true },
        "metadata": { "type": "jsonb" },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_products_sku": { "columns": ["sku"], "type": "btree", "unique": true },
        "idx_products_metadata": { "columns": ["metadata"], "type": "gin", "opclass": "jsonb_path_ops" }
      }
    },
    "orders": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "user_id": { "type": "uuid", "nullable": false, "references": "users.id" },
        "status": { "type": "text", "nullable": false, "default": "'pending'" },
        "total": { "type": "integer", "nullable": false, "default": "0" },
        "shipping_address": { "type": "jsonb" },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_orders_user_id": { "columns": ["user_id"], "type": "btree" },
        "idx_orders_status": { "columns": ["status"], "type": "btree" }
      }
    },
    "order_items": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "order_id": { "type": "uuid", "nullable": false, "references": "orders.id" },
        "product_id": { "type": "uuid", "nullable": false, "references": "products.id" },
        "quantity": { "type": "integer", "nullable": false },
        "price": { "type": "integer", "nullable": false },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_order_items_order_id": { "columns": ["order_id"], "type": "btree" },
        "idx_order_items_product_id": { "columns": ["product_id"], "type": "btree" }
      }
    },
    "reviews": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "product_id": { "type": "uuid", "nullable": false, "references": "products.id" },
        "user_id": { "type": "uuid", "nullable": false, "references": "users.id" },
        "rating": { "type": "integer", "nullable": false },
        "title": { "type": "text" },
        "body": { "type": "text" },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_reviews_product_id": { "columns": ["product_id"], "type": "btree" },
        "idx_reviews_user_id": { "columns": ["user_id"], "type": "btree" }
      }
    }
  }
}
```

---

### C) SaaS Multi-tenant

```json
{
  "appId": "YOUR_APP_ID",
  "schema": {
    "workspaces": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "name": { "type": "text", "nullable": false },
        "slug": { "type": "text", "nullable": false, "unique": true },
        "plan": { "type": "text", "nullable": false, "default": "'free'" },
        "settings": { "type": "jsonb" },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_workspaces_slug": { "columns": ["slug"], "type": "btree", "unique": true }
      }
    },
    "members": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "workspace_id": { "type": "uuid", "nullable": false, "references": "workspaces.id" },
        "user_id": { "type": "uuid", "nullable": false, "references": "users.id" },
        "role": { "type": "text", "nullable": false, "default": "'member'" },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_members_workspace_user": { "columns": ["workspace_id", "user_id"], "type": "btree", "unique": true },
        "idx_members_user_id": { "columns": ["user_id"], "type": "btree" }
      }
    },
    "projects": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "workspace_id": { "type": "uuid", "nullable": false, "references": "workspaces.id" },
        "name": { "type": "text", "nullable": false },
        "description": { "type": "text" },
        "archived": { "type": "boolean", "nullable": false, "default": "false" },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_projects_workspace_id": { "columns": ["workspace_id"], "type": "btree" }
      }
    },
    "tasks": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "project_id": { "type": "uuid", "nullable": false, "references": "projects.id" },
        "assignee_id": { "type": "uuid", "references": "users.id" },
        "title": { "type": "text", "nullable": false },
        "description": { "type": "text" },
        "status": { "type": "text", "nullable": false, "default": "'todo'" },
        "priority": { "type": "text", "nullable": false, "default": "'medium'" },
        "due_date": { "type": "timestamptz" },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_tasks_project_id": { "columns": ["project_id"], "type": "btree" },
        "idx_tasks_assignee_id": { "columns": ["assignee_id"], "type": "btree" },
        "idx_tasks_status": { "columns": ["status"], "type": "btree" }
      }
    }
  }
}
```

---

### D) Social App

```json
{
  "appId": "YOUR_APP_ID",
  "schema": {
    "profiles": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "user_id": { "type": "uuid", "nullable": false, "unique": true, "references": "users.id" },
        "username": { "type": "text", "nullable": false, "unique": true },
        "bio": { "type": "text" },
        "avatar_id": { "type": "uuid" },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_profiles_username": { "columns": ["username"], "type": "btree", "unique": true },
        "idx_profiles_user_id": { "columns": ["user_id"], "type": "btree", "unique": true }
      }
    },
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "author_id": { "type": "uuid", "nullable": false, "references": "users.id" },
        "content": { "type": "text", "nullable": false },
        "media": { "type": "jsonb" },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_posts_author_id": { "columns": ["author_id"], "type": "btree" },
        "idx_posts_created_at": { "columns": ["created_at"], "type": "btree" }
      }
    },
    "follows": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "follower_id": { "type": "uuid", "nullable": false, "references": "users.id" },
        "following_id": { "type": "uuid", "nullable": false, "references": "users.id" },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_follows_follower_following": { "columns": ["follower_id", "following_id"], "type": "btree", "unique": true },
        "idx_follows_following_id": { "columns": ["following_id"], "type": "btree" }
      }
    },
    "likes": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "user_id": { "type": "uuid", "nullable": false, "references": "users.id" },
        "post_id": { "type": "uuid", "nullable": false, "references": "posts.id" },
        "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": {
        "idx_likes_user_post": { "columns": ["user_id", "post_id"], "type": "btree", "unique": true },
        "idx_likes_post_id": { "columns": ["post_id"], "type": "btree" }
      }
    }
  }
}
```

---

## 8. Anti-Patterns

- **Using `timestamp` instead of `timestamptz`** — `timestamp` silently drops timezone info, causing subtle bugs for users in different time zones. Always use `timestamptz`.

- **Forgetting `"default": "gen_random_uuid()"` on UUID primary keys** — Without a default, inserts will fail unless the caller explicitly provides an ID. Always set this default.

- **Omitting `created_at` / `updated_at` columns** — These are essential for debugging, ordering, and audit trails. Include them on every table from the start; retrofitting them is painful.

- **Not adding a `user_id` column on tables that will need RLS** — Row-Level Security policies require a `user_id` column to exist. Adding it later requires a migration and backfill. Plan ahead.

- **Over-indexing** — Indexes speed up reads but add overhead to every write. Only index columns you actively query or sort by. Avoid indexing every column "just in case."

- **Using `text` for booleans or enums** — Use the `boolean` type for true/false values. For enums, `text` is acceptable but consider adding a CHECK constraint or a lookup table for referential integrity.

- **Storing file URLs directly** — URLs change (CDN migrations, domain changes). Store the object's UUID (`avatar_id uuid`) and resolve the URL at render time using `generate_download_url`. This decouples your data from your storage topology.
