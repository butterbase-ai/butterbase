# Butterbase backend setup (grocery list)

Exact MCP tool calls used to provision the example backend.

## Step 1: Initialize app

**Tool:** `init_app`

**Parameters:**

- `name`: `grocery-list-2026-04-03`

**Result (this environment):**

- `app_id`: `app_xcycntxmff44`
- Example API base from tool output: `http://api.butterbase.local/v1/app_xcycntxmff44`

Use the returned `app_id` in all routes and in `VITE_APP_ID`.

## Step 2: Apply schema

**Tool:** `apply_schema`

**Parameters:**

- `app_id`: `app_xcycntxmff44`
- `name`: `grocery_items_initial` (optional)

**Schema:**

```json
{
  "tables": {
    "grocery_items": {
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
        "grocery_items_user_id_idx": {
          "columns": ["user_id"]
        },
        "grocery_items_created_at_idx": {
          "columns": ["created_at"]
        }
      }
    }
  }
}
```

**Result:** Table `grocery_items` created with indexes.

## Step 3: Row-level security

**Tool:** `create_rls_policy`

**Parameters:**

- `app_id`: `app_xcycntxmff44`
- `table_name`: `grocery_items`
- `user_column`: `user_id`

**Note:** If the tool returns an error but a policy already exists, verify with `get_rls_policies` — the example policy name is `grocery_items_user_isolation`.

## Step 4: CORS

**Tool:** `update_cors`

**Parameters:**

- `app_id`: `app_xcycntxmff44`
- `allowed_origins`: `["http://localhost:5173"]`

Adjust the origin if you use another port or host for the Vite dev server.

## Step 5: Recipe assistant (serverless function)

Deploy the AI chat handler with MCP **`deploy_function`**. Source file in this repo: [functions/grocery-recipe-chat.ts](./functions/grocery-recipe-chat.ts).

**Parameters (example):**

- `app_id`: `app_xcycntxmff44` (use your app’s id)
- `name`: `grocery-recipe-chat`
- `description`: e.g. `AI recipe assistant: reads grocery_items, calls OpenAI chat completions`
- `timeoutMs`: `60000` (LLM calls can exceed the default)
- `memoryLimitMb`: `256` (optional)
- `trigger`: `{ "type": "http", "config": {} }`
- `code`: contents of `functions/grocery-recipe-chat.ts` (must include `export` and `handler` per control-plane validation)
- `envVars`: `{ "OPENAI_API_KEY": "<your key>" }` — **never commit keys**; rotate if leaked

After deploy, the invoke URL shape is:

`POST http://localhost/v1/app_xcycntxmff44/fn/grocery-recipe-chat` (host/port per your Traefik setup)

To **update** the function (new code or a new key), run `deploy_function` again with the same `name` and new `code` / `envVars`.

## Endpoints (reference)

Replace `{app_id}` with `app_xcycntxmff44` when using this provisioned app.

**Auth**

- `POST /auth/{app_id}/signup`
- `POST /auth/{app_id}/login`
- `GET /auth/{app_id}/me`

**Auto-API**

- `GET /v1/{app_id}/grocery_items`
- `POST /v1/{app_id}/grocery_items`
- `PATCH /v1/{app_id}/grocery_items/{id}`
- `DELETE /v1/{app_id}/grocery_items/{id}`

**Storage**

- `POST /storage/{app_id}/upload`
- `GET /storage/{app_id}/download/{object_id}`

**Recipe assistant**

- `POST /v1/{app_id}/fn/grocery-recipe-chat` — JSON body `{ "messages": [ ... ] }`, `Authorization: Bearer <end-user JWT>`
