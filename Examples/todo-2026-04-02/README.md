# Todo App Example

A complete example demonstrating the Butterbase user experience: building a todo application with authentication and image storage using MCP tools.

## What This Demonstrates

- **Backend provisioning** via Butterbase MCP tools (no manual configuration)
- **Email/password authentication** with JWT tokens
- **Row-level security** ensuring users only see their own data
- **Image uploads** using presigned S3 URLs
- **Auto-generated REST API** from database schema
- **React frontend** integration with Butterbase backend

## Prerequisites

- Docker and Docker Compose (for Butterbase services)
- Node.js 18+ (for frontend)
- Butterbase running locally

## Quick Start

### 1. Start Butterbase

```bash
cd /path/to/butterbase
docker-compose up -d
```

### 2. Provision Backend

The backend was provisioned using Butterbase MCP tools. See [BUTTERBASE_SETUP.md](./BUTTERBASE_SETUP.md) for the exact commands used.

If you need to recreate it:
- App ID: `todo-2026-04-02`
- Use MCP tools: `init_app`, `apply_schema`, `create_user_isolation_policy`

### 3. Install Frontend Dependencies

```bash
cd Examples/todo-2026-04-02/frontend
npm install
```

### 4. Configure Environment

```bash
cp .env.example .env
```

The default values should work for local development.

### 5. Start Frontend

```bash
npm run dev
```

Open http://localhost:5173

## Features

- **User Registration & Login** - Email/password authentication
- **Create Todos** - Add tasks with title, description, and optional image
- **Toggle Complete** - Mark todos as done/undone
- **Delete Todos** - Remove tasks
- **Image Attachments** - Upload images to todos (max 10MB)
- **Data Isolation** - Users only see their own todos (RLS with user isolation)

## Architecture

### Backend (Butterbase)
- PostgreSQL database with `todos` table
- JWT authentication via `/auth/{app_id}/*` endpoints
- Auto-generated REST API via `/v1/{app_id}/todos`
- S3 storage via `/storage/{app_id}/*` endpoints
- Row-level security on todos table

### Frontend (React + TypeScript)
- Vite build tool
- React Router for navigation
- Axios for HTTP requests
- Context API for auth state

## Project Structure

```
frontend/
├── src/
│   ├── pages/          # LoginPage, SignupPage, TodosPage
│   ├── components/     # TodoList, TodoItem, TodoForm, ImageUpload
│   ├── services/       # api, auth, storage
│   ├── contexts/       # AuthContext
│   └── types/          # TypeScript definitions
├── package.json
└── vite.config.ts
```

## API Endpoints Used

All endpoints use base URL: `http://localhost:4000`

**Auth:**
- `POST /auth/todo-2026-04-02/signup`
- `POST /auth/todo-2026-04-02/login`
- `GET /auth/todo-2026-04-02/me`

**Data:**
- `GET /v1/todo-2026-04-02/todos`
- `POST /v1/todo-2026-04-02/todos`
- `PATCH /v1/todo-2026-04-02/todos/{id}`
- `DELETE /v1/todo-2026-04-02/todos/{id}`

**Storage:**
- `POST /storage/todo-2026-04-02/upload`
- `GET /storage/todo-2026-04-02/download/{object_id}`

## Testing

1. Sign up with a new account
2. Create todos with and without images
3. Toggle completion status
4. Delete todos
5. Logout and login again
6. Create a second user account and verify data isolation

## Troubleshooting

**"Failed to fetch"**
- Ensure Butterbase services are running: `docker-compose ps`
- Check API base URL in `.env`

**"App not found"**
- Verify app was provisioned: check `BUTTERBASE_SETUP.md`
- Confirm app_id matches in `.env`

**Image upload fails**
- Check file size (max 10MB)
- Ensure LocalStack is running
- Check browser console for errors

## Learn More

- [Butterbase Documentation](../../README.md)
- [MCP Setup Guide](./BUTTERBASE_SETUP.md)
