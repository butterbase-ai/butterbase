---
app_id: app_0ycj4ad7odud
api_base: https://api.butterbase.ai/v1/app_0ycj4ad7odud
subdomain: butter-support
app_url: https://butter-support.butterbase.dev
region: us-east-1
substrate_user_id: 249d87fa-a4a9-4456-b647-f05221472bc8
hackathon_mode: false
hackathon_deadline: null
frontend_stack: vite-react
publish_as_template: yes
current_stage: DONE
last_updated: 2026-06-18T23:40:00Z
---

# Journey state

## Stages
- [x] idea (seeded verbatim from founder brief — see 01-idea.md; brainstorm skipped)
- [x] plan (see 02-plan.md — 20 tables, single-tenant, magic-link auth, DO-driven agent, commodity-first inversion, publish-as-template)
- [x] preflight (see 03-preflight.md — app_id=app_0ycj4ad7odud, substrate linked to CRM's substrate)
- [x] docs (see 03b-docs-cache.md — primed 14 topics + cross-checked against live docs.butterbase.ai; surfaced 7 plan adjustments)
- [x] schema (migration_id=1+2; 20 tables; _sys_widget_secrets renamed to widget_secrets; see 04-build-log.md)
- [x] rls (29 policies; 20 tables RLS-enabled; predicate uses current_user_id()::uuid cast; widget_secrets is service-only)
- [x] auth (auth-bootstrap-hook deployed + wired; magic-link + email/password native; first-user bootstrap path live)
- [x] storage (publicReadEnabled=false; maxFileSizeMb=10 platform default; content-type whitelist enforced at upload-URL issue time in request-doc-upload-url function)
- [x] functions (23 deployed across 4 phases — see 04-build-log.md; 14 deferred items captured in 06-v1-deferred.md)
- [x] ai (defaultModel=claude-sonnet-4.6; allowedModels=[sonnet-4.6, haiku-4.5]; maxTokensPerRequest=8192; BYOK left empty for day-0 magic moment)
- [x] rag (collection support-docs created; access_mode=shared; id=92f181a9; empty until ingest-docs is called)
- [x] realtime (6 tables: support_tickets, support_messages, agent_proposals, diagnoses, escalations, pattern_signals; RLS-enforced)
- [x] durable (SupportTicketDO deployed; commodity-tier tools; URL /_do/support-ticket-do/<ticket_id>; deep-tier tools deferred to Phase 3)
- [x] agents (support-overview platform agent deployed; spec saved to agents/support-overview.json for clone-time re-import; visibility=authenticated, daily_budget=$1)
- [x] frontend (Vite console + widget built in frontend/; dist/ artifacts generated; widget 53KB gz, console 144KB gz; see frontend/HANDOFF.md; FE4 widget URL path patch applied)
- [x] deploy (live at https://butter-support.butterbase.dev; favicon SVG; CORS configured; widget uses canonical api.butterbase.ai URL due to subdomain /fn/ router bug DEP1)
- [x] substrate (linked in preflight to substrate_user_id=249d87fa-… shared with CRM)
- [ ] submit (n/a — not a hackathon)
- [x] templates (public + listed; snapshot 9c9876fc73af; see 07-template.md)

## Notes
- Journey initialised 2026-06-16.
- Hackathon mode: false.
- Idea stage skipped — founder supplied a complete strategic brief in the opening conversation; captured verbatim in 01-idea.md.
- This app will be linked to the same substrate owner as the CRM (`butterbase-crm` / `app_44zjayftl7b3` / substrate_user_id `249d87fa-a4a9-4456-b647-f05221472bc8`) so it shares the entity graph populated by the CRM's `ingest-gmail` and `crm-upsert-meeting` flows.
- Confirmed capability naming for first safe actions: `support.resend_verification_email`, `support.retry_failed_webhook`, `support.flag_as_bug`, `support.apply_account_credit` (always-require-approval). These execute in the cloning customer's main product app via substrate outbox webhooks, not in the support recipe.
- App not yet provisioned. To be created during preflight after plan is locked.
- **Recipe is OSS / publish_as_template = yes.** Customers clone the recipe into their own Butterbase account. Each clone is independent. Substrate is the only shared surface.
- **Knowledge-depth front door: commodity (URL-scrape RAG) tier.** Deep substrate diagnosis is the headline tier, layered on top of the same recipe. Depth scales with substrate population.
- **Safety floor includes audience-scoped disclosure** (outbound channel cannot leak internal facts; structural, not prompt-based).
