# butterbaseCRM

**An open-source, substrate-native CRM for founders — companies, people, deals and meetings that live in an agent-readable memory layer, not just another Postgres table.**

Built on [Butterbase](https://butterbase.ai). Apache-2.0 — see the [root LICENSE](../../LICENSE).

Most CRMs are a database with forms on top. This one keeps its core entities in **Butterbase substrate** — a shared, agent-readable memory layer — so the workspace AI agent, your own Claude, and every function in the app see the same live picture of the business without an integration layer in between.

---

## What's inside

| Subsystem | What it is |
|---|---|
| **Substrate entities** | Companies, people, deals, meetings, meeting attendees — stored as substrate entities (`ent_*`), not app tables, so agents can read and act on them directly |
| **29 Postgres tables** | Workspaces, memberships, invites, allowlist, activity log, notes, attachments, saved views, custom fields, campaigns + sends, social posts/comments/inbox, agent threads + messages + proposals, enrichment and sync settings |
| **55+ functions** | Gmail/Calendar ingest · meeting notetaker bot + transcript ingest · company/person enrichment · duplicate finder · deal proposals · lead search & save · email campaigns · multi-platform social publishing + comment campaigns · workspace AI agent chat · substrate proxy · crons |
| **Workspace AI agent** | Chat over your CRM with a proposal flow — the agent proposes deals, edits and actions; a human approves before anything is written |
| **Integrations** | Composio-backed Gmail and Google Calendar; X/Twitter, Reddit, Instagram and TikTok for social publishing — each user connects their own accounts |
| **Realtime** | 7 tables broadcast INSERT/UPDATE/DELETE over WebSocket to the SPA |
| **Frontend** | Vite + React + Tailwind + shadcn/ui |
| **Auth** | Email/password + Google OAuth, with an `app_allowlist` login gate and admin-issued invites |
| **RLS** | Row-level security on every table, scoped by workspace membership |

## Repository layout

```
backend/     read-only mirror of the live Butterbase app (schema, RLS, functions, configs)
             — the platform is the source of truth; `./sync.sh` refreshes this folder
frontend/    Vite + React single-page app
docs/        design specs, build log, plans, known limitations
dev/         local helper scripts
QUICKSTART.md  step-by-step setup — start here
```

## Quickstart

Full instructions live in **[QUICKSTART.md](QUICKSTART.md)**. The short version:

```bash
# 1. Clone the Butterbase app so you own your own backend
butterbase clone <source_app_id> butterbaseCRM
cd butterbaseCRM

# 2. Configure secrets
cp .env.example .env                       # fill in your BUTTERBASE_API_KEY / APP_ID
cp frontend/.env.example frontend/.env.local

# 3. Run the frontend
cd frontend && npm install && npm run dev
```

> **Note on "cloning":** throughout the docs, *clone* means a **Butterbase app clone** (`manage_app` action `clone`, or `butterbase clone`) — it forks the live backend into a new `app_<id>` that you own, with its own database, URL and API key. Cloning this git repo alone gives you the frontend and a read-only view of the backend, not a running backend.

## Configuration

Every secret is read from environment variables. `.env` and `.env.local` are gitignored — copy the `.env.example` files and fill in your own values. Never commit a `bb_sk_*` service key or an OAuth client secret.

## Status

Actively developed, single-workspace-per-clone. See [TODO.md](TODO.md) for what's next and [docs/known-limitations.md](docs/known-limitations.md) for the rough edges.

## License

Apache-2.0, inherited from the Butterbase repository — see the [root LICENSE](../../LICENSE).
