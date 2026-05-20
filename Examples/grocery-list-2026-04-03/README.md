# Grocery list example

An example app that uses Butterbase as the backend: email/password auth, row-level security, Auto-API CRUD for list items, optional product photos via presigned storage uploads, and a **recipe assistant** chat powered by a serverless function and OpenAI (same broad integration pattern as the [todo example](../todo-2026-04-02/README.md)).

## What this demonstrates

- **Backend provisioning** via Butterbase MCP tools (`init_app`, `apply_schema`, `create_user_isolation_policy`, `update_cors`)
- **End-user JWT auth** (`/auth/{app_id}/*`)
- **Auto-generated REST API** for `grocery_items`
- **RLS with user isolation** so each user only sees their own rows
- **Optional images** with presigned upload URLs
- **Recipe assistant chat** — HTTP function reads the user’s `grocery_items` from the database and calls OpenAI (key stored on the function, not in the browser)
- **Vite + React** frontend

## Prerequisites

- Docker and Docker Compose (for Butterbase)
- Node.js 18+
- Butterbase running locally
- **OpenAI API key** — set as `OPENAI_API_KEY` on the deployed function (see [BUTTERBASE_SETUP.md](./BUTTERBASE_SETUP.md)); never put this in frontend env or commit it

## Quick start

### 1. Start Butterbase

```bash
cd /path/to/butterbase
docker compose up -d
```

### 2. Backend

This repo’s backend for the example was provisioned with MCP. See [BUTTERBASE_SETUP.md](./BUTTERBASE_SETUP.md) for tool calls and schema.

To point the UI at your app, set `VITE_APP_ID` in `frontend/.env` to your app’s id from `init_app`.

### 3. Install frontend dependencies

```bash
cd Examples/grocery-list-2026-04-03/frontend
npm install
```

### 4. Configure environment

```bash
cp .env.example .env
```

Adjust `VITE_API_BASE_URL` if your gateway differs (see root [Readme.md](../../Readme.md)).

### 5. Run the app

```bash
npm run dev
```

Open http://localhost:5173

## Features

- Sign up / log in
- Add items (name, optional notes, optional photo)
- Check off items when you have them
- Remove items
- Data isolated per user (RLS with user isolation)
- **Recipe assistant** — ask for meal ideas, extra ingredients, and recipes; the model sees your current list (what you still need vs already have)

## Architecture

### Backend (Butterbase)

- Postgres table `grocery_items`
- Auth and Auto-API as documented in the main Butterbase README
- Storage upload/download for images
- Serverless function `grocery-recipe-chat` for the AI assistant (source in [functions/grocery-recipe-chat.ts](./functions/grocery-recipe-chat.ts))

### Frontend

- Vite, React, TypeScript, React Router, `fetch` for Auto-API and storage routes

## API endpoints used

Base URL: value of `VITE_API_BASE_URL` (no trailing slash), e.g. `http://localhost`

**Auth**

- `POST /auth/{app_id}/signup`
- `POST /auth/{app_id}/login`
- `GET /auth/{app_id}/me`

**Data**

- `GET /v1/{app_id}/grocery_items`
- `POST /v1/{app_id}/grocery_items`
- `PATCH /v1/{app_id}/grocery_items/{id}`
- `DELETE /v1/{app_id}/grocery_items/{id}`

**Storage**

- `POST /storage/{app_id}/upload`
- `GET /storage/{app_id}/download/{object_id}`

**Recipe assistant (serverless)**

- `POST /v1/{app_id}/fn/grocery-recipe-chat` — body `{ "messages": [ { "role": "user"|"assistant", "content": "..." } ] }`, end-user JWT required; response `{ "reply": "..." }` (markdown text). The function reloads `grocery_items` for the signed-in user on each request.

## Troubleshooting

**Failed to fetch**

- Confirm Butterbase is up: `docker compose ps`
- Confirm `VITE_API_BASE_URL` matches how you reach the API (Traefik / port)

**App not found / 404 on auth**

- Check `VITE_APP_ID` matches the app from provisioning

**CORS**

- Ensure your dev origin (e.g. `http://localhost:5173`) is allowed for the app; see [BUTTERBASE_SETUP.md](./BUTTERBASE_SETUP.md)

**Recipe assistant returns 503**

- Deploy or update the function with `OPENAI_API_KEY` in `envVars` (MCP `deploy_function` or dashboard). OpenAI usage is billed to your key.

## Learn more

- [Butterbase README](../../Readme.md)
- [MCP setup for this example](./BUTTERBASE_SETUP.md)
