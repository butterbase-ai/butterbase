# Lead Finder — Design

**Date:** 2026-06-29
**Status:** Draft, pending approval
**Related research:**
- [Provider comparison](../research/2026-06-29-lead-finder-providers.md)
- [EnrichLayer recon](../research/2026-06-29-enrichlayer-recon.md)

## Goal

User types a free-text query into a search box and gets a ranked list of people back, each with name, title, company, and (where available) LinkedIn URL. User can reveal emails on demand, save results into a CRM list, and save the search itself to re-run later.

## Strategy: build provider-agnostic now, plug provider in later

Butterbase has been asked to host Apollo (or EnrichLayer) with a managed shared key, the way Recall.ai is hosted today (suggestion id `2c8a5509-6fde-44e2-9488-d244bc0ada68`). Until that ships, we still want to make progress, so we build everything *around* the provider call behind a clean interface. When the platform provides the managed key, swap one implementation file and ship.

**Done now:**
- Substrate entity model (`SavedSearch`)
- Frontend page (search box, filter chips, results table, save-to-list dialog, saved-searches view)
- Backend function `lead-search` with a `LeadSearchProvider` interface
- LLM translator (free-text query → structured filters) via Butterbase AI gateway
- Save-to-list flow (selected results → existing CRM People/Company substrate entities)
- A `MockProvider` returning deterministic fake leads so we can build and test the full UX

**Deferred (plug in when ready):**
- `ApolloProvider` (via Composio `manage_integrations`) OR `EnrichLayerProvider` (via direct REST)
- Email-reveal flow (sync for Apollo, async-webhook for EnrichLayer)
- Real credit metering

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Frontend                                                        │
│  LeadFinder page                                                │
│   ├─ free-text search box                                       │
│   ├─ visible filter chips (editable, from LLM)                  │
│   ├─ results table: name · title · company · LinkedIn · [Add]   │
│   ├─ save-to-list dialog                                        │
│   └─ saved-searches sidebar                                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │  POST /functions/lead-search
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ Function: lead-search                                           │
│  1. LLM translate (Butterbase AI gateway)                       │
│       "VPs of eng at NYC fintechs"                              │
│       → { titles: [...], industries: [...], locations: [...] }  │
│  2. LeadSearchProvider.search(filters) → SearchResult[]         │
│  3. Cache results by hash(filters) in substrate                 │
│  4. Return { results, filters, query_id }                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌──────────────────────┐    ┌──────────────────────┐
│ MockProvider         │    │ ApolloProvider       │  ← later
│ (today)              │    │ EnrichLayerProvider  │  ← later
└──────────────────────┘    └──────────────────────┘
```

## Substrate entities

Per the codebase convention (CRM entities live in substrate, not relational tables), we add:

### `SavedSearch` entity
```ts
{
  type: "saved_search",
  name: string,                    // user-given label, default = the query
  query: string,                   // raw free-text
  filters: {                       // LLM-translated structured filters
    titles?: string[],
    industries?: string[],
    locations?: string[],
    seniorities?: string[],
    company_sizes?: string[],
  },
  last_run_at?: ISO8601,
  last_result_count?: number,
  workspace_id: string,
  created_by: user_id,
}
```

### `LeadSearchCache` entity (de-duplicated provider results)
```ts
{
  type: "lead_search_cache",
  filters_hash: string,            // canonical hash of filter object
  provider: "mock" | "apollo" | "enrichlayer",
  results: SearchResult[],         // raw provider response, normalized
  total_count: number,
  cached_at: ISO8601,
  ttl_at: ISO8601,                 // 24h default, configurable
}
```

Cache by filter-hash lets us re-run a SavedSearch without re-hitting the provider when results are fresh — borrowed from Nira's pattern (30d success / 7d miss, but ours is shorter since searches are explicit not background).

When a user clicks "Add" on a result, the lead is materialized as a regular CRM `Person` (+ `Company`) entity via existing `crm-record-activity` / `list-substrate-entities` patterns. The lead-finder cache is *ephemeral*; the CRM substrate is the durable home for kept records.

## `LeadSearchProvider` interface

```ts
interface SearchResult {
  external_id: string;          // provider-specific stable id (e.g. linkedin URL)
  full_name: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  company_name?: string;
  company_domain?: string;      // needed for masked email teaser
  company_linkedin_url?: string;
  linkedin_url?: string;
  location?: string;
  email_masked?: string;        // synthesized teaser: "m****@american-express.com"
  email?: string;               // present only after enrichment / reveal
  email_status?: "verified" | "guessed" | "pending" | "unknown" | "masked";
}

interface SearchFilters {
  titles?: string[];
  industries?: string[];
  locations?: string[];
  seniorities?: string[];
  company_sizes?: string[];     // "1-10" | "11-50" | ...
}

interface LeadSearchProvider {
  name: "mock" | "apollo" | "enrichlayer";
  search(filters: SearchFilters, opts: {
    page_size?: number;
    cursor?: string;
  }): Promise<{
    results: SearchResult[];
    next_cursor?: string;
    total_count?: number;
    credit_cost?: number;        // populated when provider reports it
  }>;
  enrichEmail?(result: SearchResult): Promise<{
    email?: string;
    status: "verified" | "guessed" | "pending" | "unknown";
    credit_cost?: number;
  }>;
}
```

This interface accommodates both Apollo (sync email) and EnrichLayer (async email) — async providers return `status: "pending"` and resolve later via webhook.

## LLM translator

One Butterbase AI gateway call per search. Structured output schema matches `SearchFilters`. Prompt is provider-agnostic:

```
You translate free-text people-finder queries into structured filters.
Given: "VPs of engineering at fintech startups in NYC"
Return JSON: { titles: ["VP Engineering"], industries: ["Financial Services","Fintech"], locations: ["New York, US"], seniorities: ["vp"], company_sizes: ["11-50","51-200"] }
```

Cost: tiny (one short structured-output call per search) via Butterbase AI gateway. Cached by query text — same query string skips the LLM call.

## Email reveal flow — masked teaser + cost preview

This is the key monetization gate (modeled on Clarify):

### Step 1 — Search results show a masked email teaser
Synthesized server-side from `first_name[0]` + mask + `@` + `company_domain`:

```
Matthew Grant   VP Tech   American Express   m****@aexp.com   [link]
Wayne Fong      Director  Acme Corp          w****@acme.com   [link]
```

The masked email is **not a real lookup** — it's a deterministic visual hint that an email exists and roughly what it'll look like once revealed. Server-side synthesis (rather than client-side) keeps masking consistent and lets us be smarter about domain selection (e.g. preferring company website over LinkedIn-derived guesses).

- If `first_name` is missing → use `?****@domain.com`
- If `company_domain` is missing → use `m****@<company-slug>.com` (slug from company name)
- Costs 0 credits — derived from data already in the cheap search response

### Step 2 — Cost preview dialog on Add-to-list
When user clicks "Add to list" with N selected:

```
┌──────────────────────────────────────────────────┐
│  Add 12 leads to "Q3 prospects"?                 │
│                                                  │
│  Revealing emails will use 12 credits (≈ $0.36)  │
│  Workspace balance after: 988 credits            │
│                                                  │
│  [ Cancel ]  [ Add without emails ]  [ Confirm ] │
└──────────────────────────────────────────────────┘
```

- **"Add without emails"** — saves the leads as Person entities with `email = null`, no credits burned. User can reveal individually later.
- **"Confirm"** — burns the credits, resolves real emails, saves Person entities with email populated.

For async providers (EnrichLayer's `/profile/email`), Confirm shows "Email pending" badges on the saved entities until the webhook resolves them.

### Step 3 — Per-row reveal (alternative)
A small reveal icon next to each masked email lets the user spend 1 credit to unmask a single row without saving. Useful for "does this lead even have a real email?" checks. Same cost-preview microconfirm appears as a popover.

## Frontend

### Route: `/leads`
Sidebar link, sits between People and Companies.

### Page layout
```
┌──────────────────────────────────────────────────────────────────┐
│ [ search box: "VPs of eng at NYC fintechs"             ]  🔍    │
│ Filters: [VP Engineering ×] [Financial Services ×] [NYC ×] [+]   │
├──────────────────────────────────────────────────────────────────┤
│ 1,380 matches                              Save search ▾         │
├──────────────────────────────────────────────────────────────────┤
│ ☐  Name              Title       Company   Email (masked)  Link │
│ ☐  Matthew Grant     VP Tech     Amex      m****@aexp.com  [↗] │
│ ☐  Wayne Fong        Director    Acme      w****@acme.com  [↗] │
│ ...                                                              │
├──────────────────────────────────────────────────────────────────┤
│ 12 selected · [ Add to list ▾ ] (will cost 12 credits)           │
└──────────────────────────────────────────────────────────────────┘
```

Key UX choices (validated against research + Willow's monetization input):
- **Free-text input as primary**, filter chips below it as visible & editable — Clarify's prompt-first model with our debuggability addition.
- **Masked email shown in the results list** — gives users a sense of email availability/format without burning credits. Cheap deterministic synthesis.
- **Real email revealed only on add-to-list confirm** (Clarify pattern, monetization-aligned).
- **Cost preview dialog** before any credit-burning action — never surprise the user.
- **Save search** persists the `SavedSearch` entity; saved searches appear in a side panel and can be re-run.

### Components
- `LeadFinder.tsx` (page)
- `LeadSearchBox.tsx` — input + filter chips
- `LeadResultsTable.tsx` — uses existing `DataTable` patterns
- `SavedSearchesPanel.tsx` — sidebar listing, click to re-run
- `AddToListDialog.tsx` — pick existing list / create new / "all people"

Reuses existing `EntityAvatar`, `EnrichmentBadge`, `NewPersonDialog` components where applicable.

## Backend functions

### New
- **`lead-search`** — POST `{ query, filters?, page_size?, cursor? }` → `{ results, filters, query_id, total_count, credit_cost? }`. Body: LLM translate → cache check → provider call → synthesize `email_masked` per result → cache write → return.
- **`lead-cost-preview`** — POST `{ result_ids: [...], reveal_emails: boolean }` → `{ credits, usd_estimate, workspace_balance_after }`. Pure-read, no side effects. Used by the confirm dialog.
- **`lead-save`** — POST `{ result_ids: [...], list_id? | list_name?, reveal_emails: boolean }` → if `reveal_emails`, calls provider enrichment for each result (burning credits); creates Person/Company substrate entities; returns `{ saved_count, credits_spent, pending_email_count }`.
- **`saved-searches`** (CRUD) — POST create/update/delete, GET list. Returns `SavedSearch` entities.

### Provider modules (in `lead-search/handler.ts`)
- `providers/mock.ts` — deterministic fake data, no external calls
- `providers/apollo.ts` — stub, throws "not configured" until Composio Apollo toolkit is enabled
- `providers/enrichlayer.ts` — stub, throws "not configured" until workspace BYOK key is set

Provider selected by workspace setting `lead_finder_provider`, defaults to `mock` until configured.

## What we build today (scope of v1)

1. Substrate entity definitions (`SavedSearch`, `LeadSearchCache`)
2. `lead-search` function with LLM translator, masked-email synthesis, and `MockProvider`
3. `lead-cost-preview` function (returns fake cost from `MockProvider`)
4. `lead-save` function (today: no real enrichment; reveals "mock" emails when `reveal_emails=true`)
5. `saved-searches` CRUD function
6. Frontend `/leads` route: search box + chips + results table (with masked emails) + cost-preview dialog + add-to-list flow
7. Sidebar nav entry
8. Saved searches panel + re-run

## Provider-implication note (re: masked-email feasibility)

The masked email teaser requires `first_name` + `company_domain` from the **cheap search step** (no enrichment burn). This matters when we wire real providers:

- **Apollo:** Search returns `organization.website_url` → domain is free ✅
- **EnrichLayer:** Default search returns only LinkedIn URL. `enrich_profiles=enrich` is required to get name + company (~3 cr/result). So either:
  - (a) Pay the enrich-on-search cost upfront and treat that as "browse cost," OR
  - (b) Synthesize the mask from LinkedIn URL alone (`<linkedin-handle>@?`) — uglier UX

This is a real consideration when Butterbase wires the managed provider — Apollo's data model fits this UX better.

## What's deferred to v2

- `ApolloProvider` (when Composio Apollo toolkit is enabled in our workspace — easy)
- `EnrichLayerProvider` + async-email webhook handler
- Credit metering UI (Settings → Usage → Lead searches)
- Saved-search diffing ("3 new matches since last run")
- Per-workspace provider selection UI

## Open questions for approval

1. **Mock data shape** — should `MockProvider` return ~20 plausible fake records that vary with filters, or just a static set? (Recommend: vary with filters so UX feels real.)
2. **Lead-finder cache TTL** — 24h default for v1?
3. **Save-to-list** — does "create new list" mean creating a Campaign (existing pattern via `create-campaign-list`) or a new "List" entity? Need to check existing list semantics.
4. **Provider selection UI** — v1 hardcoded to `mock`, or expose a workspace setting now (even if Apollo/EnrichLayer options just show "Coming soon")?

## Tradeoffs accepted

- Shipping with `MockProvider` means v1 isn't user-valuable on its own — it's preparation. **The value lands when the provider ships.** Mitigation: build the saved-searches and list-integration UI thoroughly so users have working scaffolding even pre-provider.
- LLM translator adds one AI call per search (~$0.001). Negligible vs provider cost.
- Caching by `filters_hash` not `query` means two different NL queries that translate to the same filters share cache hits — usually correct, occasionally surprising. Live with it for v1.

---

## v2 swap-in point (when managed Apollo lands)

In `backend/functions/lead-search/handler.ts`, replace the block between
`=== PROVIDER BRANCH ===` markers with an HTTP fetch to
`POST /v1/<app_id>/apollo/search/person` (or call `manage_apollo.search_person`
via ctx if Butterbase exposes it that way). Map the Apollo response into the
existing `SearchResult` shape. Everything downstream (cache, save, frontend)
stays as-is.

In `backend/functions/lead-save/handler.ts`, replace the `email_status: 'pending'`
branch with a synchronous Apollo enrichment call and write the resolved email
directly into the person entity's `email` + `email_status: 'verified'` attrs.

In `backend/functions/lead-cost-preview/handler.ts`, swap the constants
(`EMAIL_CREDIT`, `USD_PER_CREDIT`) for whatever Butterbase publishes — likely
read from a managed-Apollo config endpoint or env var.
