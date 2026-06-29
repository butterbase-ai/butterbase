---
title: Lead Finder
description: Find LinkedIn people and companies by structured filters, enrich profiles, look up work emails — billed against your Butterbase credits.
sidebar:
  order: 12
---

Butterbase's People integration lets you search LinkedIn for people and companies, fetch enriched profiles, and look up work emails — all without managing a vendor API key, and all billed against your Butterbase credit balance at platform pricing.

This guide walks through a Lead-Finder-style flow end-to-end. For raw API + MCP reference, see [People API](/api-reference/people-api/) and the `manage_people` section of [MCP Tools](/api-reference/mcp-tools/#people-people--company-search--enrichment).

## What you can build

- **Lead lists** — search LinkedIn by role, company, location, education; save the matches as a list in your app.
- **Profile enrichment** — fetch full LinkedIn profile data (name, headline, work history, education) from a LinkedIn URL.
- **Work-email discovery** — find a person's work email given their LinkedIn URL (async; resolved via webhook).
- **CRM enrichment** — backfill profile data for contacts you already have a LinkedIn URL for.

## Quick example — "VPs from top colleges"

The headline use case. Find Vice Presidents in the US who graduated from an Ivy League school:

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

## The boolean syntax

Every filter accepts People's boolean syntax inside the string:

- `OR` between alternatives — `(CTO OR "VP Engineering")`
- `AND` to require multiple — `senior AND engineer`
- `NOT` to exclude — `engineer AND NOT intern`
- Double quotes for multi-word phrases — `"Vice President"`
- Parentheses to group — `(VP OR Director) AND NOT assistant`

This makes a single field much more expressive than a flat enum.

## Cost preview before paginating

To preview cost before pulling all pages, run a `page_size: 1` probe and read `totalResultCount`:

```jsonc
{ "action": "search_person", "current_role_title": "CTO", "country": "US", "page_size": 1 }
// → { data: { totalResultCount: 12345, ... }, usage: { creditsConsumed: 3, usdCost: 0.06 } }
```

Worst-case cost to paginate the whole result set:

```
totalResultCount × $0.02016 × 3 credits/result  (URLs-only)
```

For 12,345 CTOs: ~$746 to pull every URL. Plan your pagination accordingly. With `enrich_profiles: true`, multiply by another 3–5× depending on profile completeness.

## End-to-end flow

A typical Lead Finder workflow:

### 1. User describes the audience

In your UI, the user types something like *"VPs of engineering at fintech startups under 200 people, US-based"*.

### 2. Translate to filters

Either let the user pick filters in a form, or use the AI gateway to convert NL → filter object:

```jsonc
// MCP
{
  "tool": "manage_ai",
  "action": "chat",
  "messages": [
    { "role": "system", "content": "Convert the user's audience description into an People search_person filter object. Available fields: current_role_title, past_role_title, current_company_name, current_company_industry, country, region, city, education_school_name, education_degree_name, education_field_of_study. All fields accept boolean syntax. Reply with ONLY a JSON object." },
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
// → { data: { results: [...], nextPage: "https://enrichlayer.com/api/v2/...&next_token=..." } }
```

Parse `next_token` from `nextPage` and pass as `next_token` on the next call.

Each result is `{ linkedinProfileUrl, profile: null, lastUpdated: null }` — URLs only. To get full profiles, either:
- Pass `enrich_profiles: true` on the search (3 + N credits per result), or
- Fan out `get_profile` over each URL afterwards (2 credits each, cached for 30 days)

The fan-out approach is usually cheaper because the cache absorbs duplicates if the user revisits the same leads.

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

When the user opens a lead's detail view, call `get_profile`. The first view costs 2 credits ($0.04); subsequent views within 30 days are free:

```jsonc
{
  "action": "get_profile",
  "linkedin_profile_url": "https://www.linkedin.com/in/jane-doe-abc123"
}
// → { data: { fullName: "Jane Doe", headline: "VP at InwestCo", ... },
//     usage: { cached: false, usdCharged: 0.04032 } }
```

Inspect `usage.cached` to know if you hit the cache.

### 7. Look up work email (async)

This is the only flow that's genuinely asynchronous. People can't return a work email synchronously — they queue the lookup at their end and POST the result to a webhook you control.

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

Typical resolution time is **seconds to a few minutes**. There's no SLA from the vendor.

## Pricing summary

Default platform rate: **$0.02016 per People credit** ($0.0168 wholesale + 20% markup).

| Action | Credits | USD |
|---|---|---|
| `search_person` / `search_company` (URLs only) | 3 per result returned | $0.06 per result |
| Same with `enrich_profiles: true` | 3 + N per result (N = enriched profile size) | ~$0.12+ per result |
| `get_profile` cache miss | 2 | $0.04 |
| `get_profile` cache hit | 0 | Free |
| `queue_email_lookup` queue accept | 3 | $0.06 |
| Webhook email resolution | 1 | $0.02 |
| `get_credit_balance` | 0 | Free |
| Empty search (0 results) | 0 | Free |

Every call writes an `people_usage_logs` row — query directly with `select_rows` for usage analytics.

## Limits & gotchas

- **Insufficient credits → HTTP 402** if your Butterbase balance is below `$0.05`. Refill via the Billing page.
- **`page_size` is capped at 100** in the adapter (vendor limit).
- **Cache is per-app.** Two apps that both look up the same LinkedIn URL each pay once. There's no cross-app cache.
- **The cache key is the *normalized* URL** — lowercased, query/hash-stripped. `linkedin.com/in/Jane?utm=foo` and `LinkedIn.com/in/jane/` hit the same cache row.
- **Vendor data lags reality.** Job changes can take weeks to reflect. Treat profile data as eventually consistent.
- **`experiences[0]` is unreliable for current job** — People often keeps stale rows at the top of the experiences array while showing the current role in `occupation`/`headline`. Prefer those fields.
- **No phone numbers.** People doesn't expose them at this tier.
- **Email lookups can fail.** Roughly 20–40% of work-email lookups come back `status: "failed"` (vendor couldn't find one). You're not charged for the resolve credit in that case.

## See also

- [People API reference](/api-reference/people-api/) — full REST contract
- [`manage_people` MCP tool](/api-reference/mcp-tools/#people-people--company-search--enrichment) — agent-facing tool reference
- [AI Gateway](/api-reference/ai-api/) — pair with `manage_ai.chat` for NL → filter translation
- [Realtime API](/api-reference/data-api/) — push email resolution events to the client
