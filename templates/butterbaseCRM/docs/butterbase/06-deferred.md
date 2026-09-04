# Deferred features

Captured 2026-06-03 from a feature-gap review against Clarify (the CRM the template is mimicking). Willow's directive: ship the basics first, defer the items below. Order within each section is rough priority.

## Deferred — AI agent layer (was §D in the gap review)

These are Clarify's "autonomous CRM" differentiators. None are in the current build.

1. **Auto-deal creation from activity.** AI watches inbound emails/meetings, proposes a deal linked to the inferred company/person. Implementation hook: `propose_action` via substrate so the owner approves before the row lands.
2. **AI meeting bot.** Joins Google Meet, transcribes, writes summary + action items back to `meetings.notes`. Probably out of scope for a template app — recommend documenting as "v2 — bring-your-own bot" rather than building.
3. **Pre-meeting briefing.** Before a calendar meeting, generate a 1-paragraph "who you're meeting + recent context" card. Cheap once calendar + activity exist.
4. **Post-meeting summarization.** When a user types meeting notes, run them through the AI gateway, emit `activity.kind='meeting.summarized'` with extracted action items.
5. **Merge suggestions.** Surface "Merge?" banner when two `people` or `companies` rows clearly refer to the same entity (same domain + similar name).
6. **AI Search.** Natural-language query bar that translates "companies I emailed last week with no open deal" → structured filter over the rows.

## Deferred — Power-user UX (was §E in the gap review)

Clarify exposes these on paid tiers; we can ship without.

7. **Smart Views / saved filters.** Named, persisted `(filter, sort, columns)` tuple per workspace. New `saved_views` table when built.
8. **Custom fields & custom objects.** Workspace-defined columns. Clarify's free tier allows 2 custom objects. "AI fields" (auto-filled enum) is the interesting variant.
9. **Tags / labels.** Multi-tag on companies/people/deals.
10. **Email campaigns / sequences.** Multi-step outbound automation. Large build; defer indefinitely.
11. **Mac app + Chrome extension.** Out of scope for a Butterbase template app.

## Already deferred from v1 spec (kept here for visibility)

From `05-frontend-spec.md` §17:
- Bulk CSV import
- Mobile-responsive polish (desktop-only ~1024px+)
- Teammate name resolution in Activity Feed / Members list (blocked by narrowed `memberships` SELECT — see `backend/README.md:85`)

## What we ARE building next (for reference)

Active workstream (PRs 1–3 in priority order):
- **PR 1 — UI parity.** Rename "New company" → "Add Company", collapse to single `Domain or name` combobox, swap Companies list default columns to Company/Domains/Description/LinkedIn, fix broken `summarize-company` invoke path.
- **PR 2 — Auto-enrichment.** `enrich-company` + `enrich-person` functions, triggered on insert. Provider: People Data Labs (primary, by domain — PDL accepts `website` alone as a sufficient identifier), Exa as fallback for description/logo when PDL misses. Wired via **direct REST + function envVars** rather than Composio — see "Why not Composio for PDL/Exa" below.

### Why not Composio for PDL/Exa

Originally planned Composio for parity with Gmail. On closer look, Composio's connection model is per-user OAuth/API-key — every workspace owner would need to paste their own PDL + Exa key in a settings flow before enrichment worked. For a shared-service enrichment layer that's bad UX. We use direct REST (PDL `/v5/company/enrich`, Exa `/contents`) with API keys stored as encrypted function envVars on `enrich-company` and `enrich-person`. Composio still owns Gmail/Calendar in PR 3, where per-user OAuth is the correct model.
- **PR 3 — Gmail + Calendar ingestion.** Scheduled `ingest-gmail` + `ingest-calendar` functions, `integration_state` cursor table, "Sync inbox now" button. Uses existing Composio managed Gmail auth (scope minimization deferred — see below).

## Deferred — OAuth scope minimization

Decision 2026-06-03: keep Composio's managed Gmail auth for now and skip the extra setup step, even though it requests broader scopes than we use (includes birthday/address/phone in the consent screen). Revisit when we either (a) hit Google's verification gate at 100 users, (b) get user trust complaints about the consent screen, or (c) ship Calendar ingestion and want a cleaner combined consent.

When we do revisit: register our own Google Cloud OAuth client, request only `openid email profile gmail.readonly gmail.send calendar.readonly`, and switch Composio to a custom auth config. Existing users would reconsent once.

## Enrichment provider candidates (for PR 2)

All available through `manage_integrations` (Composio-backed). Pick one as primary:

| Provider | Composio toolkit | Company-by-domain | Person-by-email | Notes |
|---|---|---|---|---|
| **People Data Labs** | `peopledatalabs` | ✅ `Enrich Company Data` (firmographics, employee count) | ✅ `Enrich person data` | Best schema match — returns exactly the fields we already have columns for. Bulk variant up to 100. |
| **Apollo** | `apollo` | ✅ `Enrich organization data` + bulk (up to 10 by domain) | ✅ `Enrich person with Apollo` | CRM-grade. Bulk org enrichment confirmed. Search endpoints consume credits on every call (no free plan). |
| **Exa** | `exa` | ❌ no structured enrichment | ❌ | Web-search/scrape only. Useful as **fallback** when PDL/Apollo miss a company — scrape the domain homepage to extract description/logo. Not primary. |
| (DIY) | — | fetch domain HTML, send to AI gateway | derive from email signature | Zero new vendor cost; quality is lower. |

**Recommendation:** People Data Labs as primary (closest schema fit, person-by-email is the workflow Gmail ingestion needs), Exa as fallback for description/logo scraping when PDL misses. Confirm pricing before wiring.
