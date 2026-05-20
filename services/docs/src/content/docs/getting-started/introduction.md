---
title: Introduction
description: Butterbase is a backend platform built for developers who build products with AI assistants.
---

Backend built for AI-assisted development.

Butterbase is an AI-optimized Backend-as-a-Service platform for modern applications. It provides a comprehensive backend out of the box with PostgreSQL, JWT-based authentication, and S3-compatible storage. Every endpoint, from initial configuration to database operations to file uploads, is designed to be agent-friendly with consistent patterns and predictable responses.

Connect your AI assistant to Butterbase using our MCP server, and it can read documentation, set up your backend, and write complete applications, all from simple prompts. No backend knowledge required.

## Why Butterbase?

Backend development with AI agents has long been a half-solved problem. AI can generate frontend code efficiently but struggles with backend complexity — database setup, authentication flows, API design all require deep expertise. Rather than forcing developers to piece together multiple services or become DevOps experts, we believe we can do better as a community — hence, Butterbase.

## What you get

- **Apps** — Each project is an isolated backend with its own database, identifier, and API base URL. Creating an app gives you everything your client code needs to get started.
- **Multi-region** — Choose where your app's data and compute live, close to your users. Move between regions as your audience grows. One API URL works from anywhere.
- **Declarative schema** — You describe tables and columns in a JSON format; the platform diffs your desired state against the current database and applies only the necessary changes. You can preview changes before they run.
- **Automatic data API** — Once tables exist, full CRUD operations are available over HTTP with filtering, sorting, and pagination. No code generation or manual route setup required.
- **Sign-in for your users** — Email/password registration, login, email verification, password reset, and social sign-in (OAuth with any provider) can be configured per app.
- **Per-user data rules (RLS)** — You can restrict rows so each signed-in user only accesses their own data. One tool call to enable on any table.
- **File storage** — Upload and download files through presigned URLs. Files are organized per-app and per-user with configurable size limits and content-type restrictions.
- **Serverless functions** — Deploy TypeScript/JavaScript functions that run on demand (HTTP triggers) or on a schedule (cron). Functions can access your app's database, use environment variables, and return custom responses.
- **Frontend deployment** — Deploy static frontends (React, Next.js, plain HTML) to a live URL with a single tool call. Global delivery and HTTPS included.
- **AI model gateway** — Call large language models (Claude, GPT-4, Llama, and more) through an OpenAI-compatible API. Bring your own key or use the platform's shared key with usage tracking.
- **Native RAG** — Ingest documents (PDF, DOCX, TXT, and more) and query them with natural language in two API calls. The platform handles chunking, embedding with `text-embedding-3-small`, and vector storage via pgvector. No ML infrastructure required.
- **Realtime** — WebSocket-based real-time data change notifications with RLS-aware filtering, presence tracking, and custom event triggers.
- **Billing & usage tracking** — Free, Pro, and Enterprise plans with usage-based metering for AI credits, storage, function invocations, and bandwidth.
- **Monetize your app** — Optional Stripe Connect flows so your end users can subscribe to plans you define.

## Typical workflow

1. Create an app and note its `app_id` and API base URL.
2. Define your schema (tables, columns, types, constraints).
3. Preview with dry-run, then apply your schema.
4. Set row-level rules on tables that store user-owned data.
5. Configure how your end users sign in (email/password and/or OAuth providers).
6. Optionally configure CORS origins for your frontend domain.
7. Optionally deploy serverless functions for custom backend logic.
8. Optionally add AI capabilities using the model gateway.
9. Optionally ingest documents into a RAG collection for semantic search.
10. Deploy your frontend for a live URL, or call the data API from your own frontend.
11. Monitor usage through the billing dashboard.

## Next steps

Ready to start building? Check out our [framework examples](/guides/react) to see how to build complete applications with Butterbase and AI assistance.

- [Quickstart](/getting-started/quickstart) — Get your first app running in 5 minutes
- [MCP Setup](/getting-started/mcp-setup) — Connect your AI assistant
- [Dashboard](/getting-started/dashboard) — Explore the management UI
