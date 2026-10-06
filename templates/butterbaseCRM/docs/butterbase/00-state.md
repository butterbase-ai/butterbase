---
app_id: app_44zjayftl7b3
api_base: https://api.butterbase.ai/v1/app_44zjayftl7b3
hackathon_mode: false
hackathon_deadline: null
frontend_stack: vite-react-shadcn
current_stage: DONE
last_updated: 2026-06-02T09:25:30Z
---

# Journey state

## Stages
- [x] idea
- [x] plan
- [x] preflight
- [x] docs
- [x] schema
- [x] rls
- [x] auth
- [x] storage
- [x] functions
- [x] ai
- [ ] rag (n/a)
- [x] realtime
- [ ] durable (n/a)
- [x] frontend
- [x] deploy
- [x] substrate (linked; CRM↔substrate sync shipped 2026-06-02 — see 04b-substrate.md)
- [ ] submit (n/a — not a hackathon)

## Notes
- Journey initialised 2026-06-02.
- Goal: Clarify-style open-source CRM clone as a public Butterbase template app (Companies, People, Deals core).
- 2026-06-02: Frontend now lives under `frontend/` subdir; root reserved for backend code.
- 2026-06-02: docs 01–04 were lost during a scaffolding mishap (npm create vite --overwrite) and could not be recovered. Only 00-state.md and 05-frontend-spec.md remain. The spec is self-contained per its §0, so frontend build can continue.
- 2026-06-07: Email Campaigns shipped — Clarify-style "save AI search as audience → drip personalised emails via Gmail". 4 new tables (campaign_lists, campaign_list_members, campaigns, campaign_sends), 4 functions (create-campaign-list, start-campaign, pause-campaign, process-campaign-sends cron `*/5 * * * *`). Daily limit hard-clamped to 30/day per campaign (1–30); throttle 60–3600s. AI search dialog gets "Save as list"; new `/campaigns` page with detail, pause/resume/cancel, live send progress via realtime.
- 2026-06-07: Per-object toolbar + Ask AI bar shipped — 3 new tables (saved_views, custom_fields, custom_field_values) + RLS + realtime. New function `ai-suggest-filters` translates NL → Filter DSL. New filter DSL in `lib/filterDsl.ts` shared by toolbar, saved views, AI search. Components: `ObjectToolbar`, `FieldsPopover`, `FilterPopover`, `SavedViewsMenu`, `AISearchButton`, `NewCustomFieldDialog`, `CustomFieldCell`, `AskAIBar`. The floating Ask AI bar pre-loads the active saved view as context (dismissable via X); reuses existing `AgentChat` via a new `viewContext` slot on the agent UI store. Wired across People (full), Companies (full), Deals (kanban + filters), Meetings (bar only — calendar view stays).
