# Idea

**One-liner:** Sales/ops teams using Butterbase track companies, people, and deals in scattered spreadsheets and a separate paid CRM (Clarify/Attio/HubSpot), with no link between that data and the rest of their Butterbase apps.

**First user:** Small team — a few teammates sharing the same workspace.
**First action:** Sign in, land on an empty Companies list, click "+ New company" to enter their first record.
**One screen:** Companies list view — Clarify-style sortable/filterable table with inline edit. This is the default landing screen; Company detail, Deals kanban, and Global activity feed also ship in v1.

## Must-haves
- Workspace-scoped data isolation (users belong to a workspace via a `memberships` table; RLS keyed on `workspace_id`) → manage_rls
- Companies / People / Deals core objects with custom-field-friendly schema → manage_schema
- Clarify-style list view (sort, filter, inline edit) as the default landing screen
- Company detail page, Deals kanban, Global activity feed (all v1)
- File uploads: company logos, person avatars, deal attachments → manage_storage
- Live row updates across team members (no presence cursors in v1) → manage_realtime
- "Summarise this company" — single-call LLM overview from the company's notes/deals → manage_ai
- Substrate integration: Companies and People surface as substrate entities so other Butterbase apps for the same user share identity (per user's explicit ask) → substrate stage

## Post-hackathon (nice-to-have)
- _n/a — not a hackathon_

## Deferred to v2
- Scheduled jobs (daily digest, stale-deal nudge) — `deploy_function` cron, deferred until real users ask

## Capability map
| Capability | Used? | Why |
|---|---|---|
| manage_schema | yes | Companies, People, Deals, Notes, Workspaces, Memberships |
| manage_rls | yes | workspace-scoped isolation (multi-team template) |
| manage_oauth | likely | Google sign-in expected for the small-team audience (firmed up in auth stage) |
| manage_storage | yes | company logos, person avatars, deal attachments |
| deploy_function | no (v1) | no scheduled or webhook jobs in v1 |
| manage_ai | yes | "Summarise this company" overview |
| manage_rag_content | no | structured records, not document search |
| manage_realtime | yes | live row updates across the team |
| manage_durable_objects | no | no chat/cursors/per-actor state |
| substrate | yes | Companies and People as cross-app substrate entities (user's explicit ask) |

## Toolchain
- `@butterbase/sdk` — frontend (and any Node code) talks to the deployed app: auth, db queries, storage, realtime, function invocation.
- `@butterbase/cli` — local dev loop: scaffolding, log tailing, schema diff preview, API-key generation.
- Butterbase MCP tools (this plugin) — orchestrate provisioning, schema apply, deployments, integrations.
