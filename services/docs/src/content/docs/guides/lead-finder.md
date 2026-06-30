---
title: Lead Finder
description: Find people and companies by structured filters or natural-language query, enrich profiles, look up work emails — billed against your Butterbase credits.
sidebar:
  order: 12
---

Butterbase's people search lets you find people and companies, fetch enriched profiles, and look up work emails — all without managing a provider API key, and all billed against your Butterbase credit balance at platform pricing.

This guide walks through a Lead-Finder-style flow end-to-end. For raw API + MCP reference, see [People API](/api-reference/people-api/) and the `manage_people` section of [MCP Tools](/api-reference/mcp-tools/#people-people--company-search--enrichment).

## What you can build

- **Lead lists** — search by role, company, location, education, or a natural-language description; save the matches as a list in your app.
- **Profile enrichment** — fetch full profile data (name, headline, work history, education) from a LinkedIn URL.
- **Work-email discovery** — find a person's work email given their LinkedIn URL (async; resolved via webhook).
- **CRM enrichment** — backfill profile data for contacts you already have a LinkedIn URL for.

## Quick start

### Natural-language query

Pass a `query` field for free-form description of the ideal match:

```jsonc
// MCP
{
  "tool": "manage_people",
  "action": "search_person",
  "query": "founder of a YC-backed AI startup based in San Francisco",
  "page_size": 25
}
```

```bash
# REST
curl -X POST https://api.butterbase.ai/v1/$APP_ID/people/search/person \
  -H "Authorization: Bearer $BB_SK" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "founder of a YC-backed AI startup based in San Francisco",
    "pageSize": 25
  }'
```

### Structured filters

Use individual filter fields instead of (or in addition to) `query`. When both are provided, `query` takes priority.

```jsonc
// MCP
{
  "tool": "manage_people",
  "action": "search_person",
  "current_role_title": "(VP OR \"Vice President\") AND NOT assistant",
  "education_school_name": "(Harvard OR Stanford OR MIT OR Princeton OR Yale)",
  "country": "US",
  "page_size": 25
}
```

```bash
# REST
curl -X POST https://api.butterbase.ai/v1/$APP_ID/people/search/person \
  -H "Authorization: Bearer $BB_SK" \
  -H "Content-Type: application/json" \
  -d '{
    "currentRoleTitle": "(VP OR \"Vice President\") AND NOT assistant",
    "educationSchoolName": "(Harvard OR Stanford OR MIT OR Princeton OR Yale)",
    "country": "US",
    "pageSize": 25
  }'
```

Returns up to 25 results plus `totalResultCount` (the full universe matching the filter) and a `nextPage` cursor for pagination.

## Structured filter syntax

Structured filter fields accept boolean operators inside the string:

- `OR` between alternatives — `(CTO OR "VP Engineering")`
- `AND` to require multiple — `senior AND engineer`
- `NOT` to exclude — `engineer AND NOT intern`
- Double quotes for multi-word phrases — `"Vice President"`
- Parentheses to group — `(VP OR Director) AND NOT assistant`

Boolean operators are honored where the configured search backend supports them; for semantic backends they serve as ranking hints rather than strict filters. Behavior may vary by deployment.

## Cost preview before paginating

To preview cost before pulling all pages, run a `page_size: 1` probe and read `totalResultCount`:

```jsonc
{ "action": "search_person", "current_role_title": "CTO", "country": "US", "page_size": 1 }
// → { data: { totalResultCount: 12345, ... }, usage: { creditsConsumed: 7, usdCost: 0.007 } }
```

Plan your pagination based on `totalResultCount` and the typical cost-per-page shown in the [People API pricing table](/api-reference/people-api/#pricing).

## End-to-end flow

A typical Lead Finder workflow:

### 1. User describes the audience

In your UI, the user types something like *"VPs of engineering at fintech startups under 200 people, US-based"*.

### 2. Translate to a search

Either pass the description directly as `query`, or let the user pick filters in a form, or use the AI gateway to convert natural language to a filter object:

```jsonc
// Option A — pass directly as query
{
  "action": "search_person",
  "query": "VPs of engineering at fintech startups under 200 people, US-based",
  "page_size": 25
}

// Option B — AI gateway converts NL → filters
{
  "tool": "manage_ai",
  "action": "chat",
  "messages": [
    { "role": "system", "content": "Convert the user's audience description into a search_person filter object. Available fields: current_role_title, past_role_title, current_company_name, current_company_industry, country, region, city, education_school_name, education_degree_name, education_field_of_study. All fields accept boolean syntax. Reply with ONLY a JSON object." },
    { "role": "user", "content": "VPs of engineering at fintech startups under 200 people, US-based" }
  ]
}
// → '{ "current_role_title": "(VP OR \"Vice President\") AND engineering", "current_company_industry": "Financial Services", "country": "US" }'
```

(Combine with `search_company` filtered by `employee_count_max: 200` if you want to restrict to companies first, then search people *at* those companies.)

### 3. Probe + show estimated cost

Run with `page_size: 1` first. Show the user `totalResultCount` and the estimated cost to pull the next N pages. Let them refine before committing.

### 4. Paginate the results

```jsonc
{ "action": "search_person", "current_role_title": "...", "page_size": 25 }
// → { data: { results: [...], nextPage: "https://api.platform.example.com/...&next_token=..." } }
```

Parse `next_token` from `nextPage` and pass as `next_token` on the next call.

Each result is a `SearchPersonResult` with a `linkedinProfileUrl` and an inline `profile` object. Fan out `get_profile` over each URL to get a fresher or more complete profile (2 credits each, cached for 30 days). The cache absorbs duplicates if the user revisits the same leads.

### 5. Save leads to your CRM

Persist the LinkedIn URLs (and any inline profile data) in your own app DB. A reasonable schema:

```sql
CREATE TABLE lead_lists (
  id            uuid PRIMARY KEY,
  owner_id      uuid NOT NULL,
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lead_list_members (
  id              uuid PRIMARY KEY,
  list_id         uuid NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  linkedin_url    text NOT NULL,
  full_name       text,
  headline        text,
  email           text,                                   -- populated after email lookup resolves
  email_status    text DEFAULT 'unknown',                 -- 'unknown' | 'pending' | 'found' | 'not_found'
  enriched_at     timestamptz,
  UNIQUE (list_id, linkedin_url)
);
```

Apply via `manage_schema`.

### 6. Enrich on demand

When the user opens a lead's detail view, call `get_profile`. The first view costs 2 credits; subsequent views within 30 days are free:

```jsonc
{
  "action": "get_profile",
  "linkedin_profile_url": "https://www.linkedin.com/in/jane-doe-abc123"
}
// → { data: { fullName: "Jane Doe", headline: "VP at InwestCo", ... },
//     usage: { cached: false, usdCharged: 0.040 } }
```

Inspect `usage.cached` to know if you hit the cache.

### 7. Look up work email (async)

Work-email lookups are asynchronous — the platform queues the request and waits for a provider webhook callback.

```jsonc
{
  "action": "queue_email_lookup",
  "linkedin_profile_url": "https://www.linkedin.com/in/jane-doe-abc123"
}
// → { lookupId: "0e9796cf-...", status: "pending", usage: { creditsConsumed: 3 } }
```

In your UI, show the lead with a "Finding email…" badge.

Poll until resolved:

```jsonc
{ "action": "get_email_lookup", "id": "0e9796cf-..." }
// pending → { status: "pending", email: null, credits_consumed: 0 }
// resolved → { status: "resolved", email: "jane.doe@inwestco.com", credits_consumed: 1 }
// failed → { status: "failed", email: null, credits_consumed: 0 }  (email not found)
```

Or, more elegantly: subscribe to changes on `people_email_lookups` via the Realtime API for instant push.

Typical resolution time is **seconds to a few minutes**.

## Pricing summary

Costs depend on which provider the operator has routed each action to. See the [People API reference](/api-reference/people-api/#pricing) for typical defaults; actual cost per call is always reflected in the `x-people-*` response headers and the `usage` body.

Every call writes a `people_usage_logs` row — query directly with `select_rows` for usage analytics.

## Limits & gotchas

- **Insufficient credits → HTTP 402** if your Butterbase balance is below `$0.05`. Refill via the Billing page.
- **`page_size` is capped at 100** in the adapter (vendor limit).
- **Cache is per-app.** Two apps that both look up the same LinkedIn URL each pay once. There's no cross-app cache.
- **The cache key is the *normalized* URL** — lowercased, query/hash-stripped. `linkedin.com/in/Jane?utm=foo` and `LinkedIn.com/in/jane/` hit the same cache row.
- **Profile data lags reality.** Job changes can take weeks to reflect. Treat profile data as eventually consistent.
- **`experiences[0]` is unreliable for current job** — the search backend often keeps stale rows at the top of the experiences array while showing the current role in `occupation`/`headline`. Prefer those fields.
- **No phone numbers.** The platform does not expose them at this tier.
- **Email lookups can fail.** Roughly 20–40% of work-email lookups come back `status: "failed"` (email not found). You're not charged for the resolve credit in that case.

## See also

- [People API reference](/api-reference/people-api/) — full REST contract
- [`manage_people` MCP tool](/api-reference/mcp-tools/#people-people--company-search--enrichment) — agent-facing tool reference
- [AI Gateway](/api-reference/ai-api/) — pair with `manage_ai.chat` for NL → filter translation
- [Realtime API](/api-reference/data-api/) — push email resolution events to the client
