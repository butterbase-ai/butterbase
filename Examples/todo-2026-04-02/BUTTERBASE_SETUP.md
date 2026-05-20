# Butterbase Backend Setup

This document shows the exact MCP tool calls used to provision the backend for this todo app example.

## Step 1: Initialize App

Tool: `init_app`
Parameters:
- name: `todo-2026-04-02`

Result:
- app_id: `app_14obgf28uzwa`
- API base URL: `http://api.butterbase.local/v1/app_14obgf28uzwa`

## Step 2: Apply Schema

Tool: `apply_schema`
Parameters:
- app_id: `app_14obgf28uzwa`
- schema: [see below]

Schema:
```json
{
  "tables": {
    "todos": {
      "columns": {
        "id": {
          "type": "uuid",
          "primaryKey": true,
          "default": "gen_random_uuid()"
        },
        "user_id": {
          "type": "uuid",
          "nullable": false
        },
        "title": {
          "type": "text",
          "nullable": false
        },
        "description": {
          "type": "text",
          "nullable": true
        },
        "completed": {
          "type": "boolean",
          "default": "false"
        },
        "image_url": {
          "type": "text",
          "nullable": true
        },
        "created_at": {
          "type": "timestamp",
          "default": "now()"
        },
        "updated_at": {
          "type": "timestamp",
          "default": "now()"
        }
      },
      "indexes": {
        "user_id_idx": {
          "columns": ["user_id"]
        },
        "created_at_idx": {
          "columns": ["created_at"]
        }
      }
    }
  }
}
```

Result: Schema applied, todos table created with 2 indexes

## Step 3: Enable RLS

Tool: `create_user_isolation_policy`
Parameters:
- app_id: `app_14obgf28uzwa`
- table_name: `todos`
- user_column: `user_id`

What it does:
- Enables RLS on the todos table
- Creates a policy so users only see their own todos
- Adds a trigger to auto-populate user_id on INSERT

Result: RLS policy active, users can only access their own todos

**Alternative (advanced):** For custom policies, use `enable_rls` + `create_policy`

## Step 4: Configure CORS

To allow the frontend (running on http://localhost:5173) to access the backend APIs, add the origin to the allowed_origins:

```sql
UPDATE apps SET allowed_origins = ARRAY['http://localhost:5173'] WHERE id = 'app_14obgf28uzwa';
```

Result: Frontend can now make requests to auth and API endpoints

## Available Endpoints

### Auth
- POST /auth/app_14obgf28uzwa/signup
- POST /auth/app_14obgf28uzwa/login
- GET /auth/app_14obgf28uzwa/me

### Data API
- GET /v1/app_14obgf28uzwa/todos
- POST /v1/app_14obgf28uzwa/todos
- PATCH /v1/app_14obgf28uzwa/todos/{id}
- DELETE /v1/app_14obgf28uzwa/todos/{id}

### Storage
- POST /storage/app_14obgf28uzwa/upload
- GET /storage/app_14obgf28uzwa/download/{object_id}
- DELETE /storage/app_14obgf28uzwa/{object_id}
