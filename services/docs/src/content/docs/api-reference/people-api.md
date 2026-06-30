---
title: People API
description: Complete reference for the People REST endpoints — structured-filter and semantic people/company search, profile lookups, async work-email lookup, and credit metering.
sidebar:
  order: 8
---

Endpoints for finding people and companies, fetching enriched profiles, and queuing async work-email lookups via Butterbase's built-in people search. Useful for lead finders, CRM enrichment, and people-search features.

All endpoints are app-scoped — the `app_id` lives in the URL path and the call is authenticated with a Butterbase service-key (`bb_sk_...`) or JWT belonging to that app's owner.

Every call is metered against the user's Butterbase credit balance at platform pricing. Cache hits are free.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | /v1/\{app_id\}/people/search/person | Structured + semantic search for people |
| POST | /v1/\{app_id\}/people/search/company | Structured + semantic search for companies |
| POST | /v1/\{app_id\}/people/profile | Enrich a profile by LinkedIn URL (30-day cache) |
| POST | /v1/\{app_id\}/people/profile/email | Queue an async work-email lookup |
| GET | /v1/\{app_id\}/people/email-lookup/\{lookup_id\} | Poll a pending email lookup |

## Response headers

Every people response (success and error) carries these headers so callers can track cost without parsing the body:

| Header | Notes |
|---|---|
| `x-people-provider` | Which provider slot served the call (`primary` or `secondary`) |
| `x-people-credits-consumed` | Integer |
| `x-people-usd-cost` | What Butterbase owes the configured provider |
| `x-people-usd-charged` | What was deducted from the user |
| `x-people-cached` | Profile route only |

Headers are present on every reply path — success, cache hit, balance-gate rejection (402), and error (503/4xx). For error or balance-rejection paths, numeric headers are `0` or `0.000000`. The `x-people-cached` header appears only on the `/profile` route.

## Pricing

Costs vary by which provider the operator routes the action to. Numbers below are typical defaults for the standard platform configuration; actual cost per call is always reported in the `x-people-*` response headers and the `usage` body.

| Action | Typical credits | Typical USD | Notes |
|---|---|---|---|
| `search/person` (up to 10 results) | 7 | $0.007 | Scales with result count; ~$0.001 per additional result above 10 |
| `search/company` (up to 10 results) | 7 | $0.007 | Same scaling |
| `profile` (cache miss) | 2 | $0.040 | Variable; depends on configured profile provider |
| `profile` (cache hit, within 30 days) | 0 | $0 | Always free |
| `profile/email` (queue) | 3 | $0.060 | Charged at queue time |
| Email lookup resolved (provider webhook) | 1 | $0.020 | Charged when the async result arrives |
| Empty result set | 0 | $0 | Never billed |

Costs vary by deployment — each platform operator configures pricing and routing independently. The actual credit count and USD cost for any individual call is always reported in the `x-people-*` response headers and the `usage` field of the body, so client code never needs to guess. Treat the numbers in the table above as typical defaults, not contractual values.

## Authentication

```
Authorization: Bearer {service-key or JWT}
```

The call's user must own the app referenced by `{app_id}` — Butterbase enforces this via an ownership check on every route. Non-owners get `403 Forbidden`.

## Search people

```
POST /v1/{app_id}/people/search/person
Authorization: Bearer {token}
Content-Type: application/json

{
  "query": "founder of a YC-backed AI startup based in San Francisco",
  "country": "US",
  "pageSize": 25
}
```

Both structured filters and the optional `query` field are accepted. When `query` is set it takes priority; when omitted, the structured fields are stitched into a natural-language description automatically and sent to the configured search backend.

The platform's search backend interprets all queries semantically. Boolean operators (`AND`, `OR`, `NOT`, parentheses, double-quoted phrases) may be included in structured fields and are honored where the configured provider supports them; for semantic providers they are treated as ranking hints rather than strict filters. Behavior may vary by deployment.

| Field | Type | Notes |
|---|---|---|
| `query` | string | Optional. Free-form natural-language description of the ideal match. Takes priority over structured filters when set. |
| `currentRoleTitle` | string | Current job title. Boolean syntax honored as a ranking hint. |
| `pastRoleTitle` | string | Any past role. |
| `currentCompanyName` | string | |
| `currentCompanyIndustry` | string | |
| `country` | string | E.g. `US`, `GB`. |
| `region` | string | State/region. |
| `city` | string | |
| `educationSchoolName` | string | E.g. `(Harvard OR Stanford)`. |
| `educationDegreeName` | string | E.g. `MBA`, `PhD`, `MD`. |
| `educationFieldOfStudy` | string | E.g. `"Computer Science"`. |
| `pageSize` | number | 1–100. |
| `nextToken` | string | Pagination cursor from a prior response. |

### Response

```json
{
  "data": {
    "results": [
      {
        "linkedinProfileUrl": "https://www.linkedin.com/in/jane-doe-abc123",
        "profile": {
          "fullName": "Jane Doe",
          "firstName": "Jane",
          "lastName": "Doe",
          "headline": "Founder at InwestCo",
          "city": "San Francisco",
          "state": "CA",
          "country": "US",
          "experiences": [
            { "title": "Founder", "company": "InwestCo", "location": "San Francisco, CA", "startsAt": "2021-03", "endsAt": null }
          ],
          "education": [
            { "school": "Stanford University", "degree": "BS Computer Science", "schoolUrl": "https://www.linkedin.com/school/stanford-university/", "dates": "2013–2017" }
          ],
          "skills": ["Product Strategy", "AI", "Fundraising"],
          "languages": ["English"],
          "profilePicUrl": "https://media.licdn.com/..."
        },
        "lastUpdated": "2026-06-15T00:00:00Z"
      }
    ],
    "nextPage": "https://api.platform.example.com/search/person?next_token=...",
    "totalResultCount": 8269
  },
  "usage": {
    "creditsConsumed": 7,
    "usdCost": 0.007,
    "usdCharged": 0.0084
  }
}
```

Not every field is guaranteed for every result — providers vary in what they expose. `linkedinProfileUrl` may occasionally point to an internal reference page when the canonical LinkedIn URL is not reliably available.

`totalResultCount` is the search backend's count for the full filter — useful for cost-preview before paginating. `nextPage` (when present) embeds a `next_token`; extract and pass as `nextToken` on the next request.

### Errors

| HTTP | Body | When |
|---|---|---|
| 402 | `{ "error": "insufficient_credits" }` | User's total Butterbase credit balance is below the minimum gate (default $0.05). No provider call is made. |
| 403 | `{ "error": "forbidden" }` | Authed user doesn't own the app. |
| 404 | `{ "error": "app_not_found" }` | No app with that ID. |
| 502 | The configured search/enrichment provider returned an upstream error. Body contains a transient error description — don't machine-parse; treat as retryable. |
| 503 | `{ "error": "people_disabled" }` | Feature flag is off on this deployment. |
| 503 | `{ "error": "people_unavailable" }` | No provider registered for this deployment. |
| 503 | `{ "error": "provider_not_registered", "slot": "primary" }` | Operator misconfiguration; no provider configured for the slot this action routed to. |
| 503 | `{ "error": "provider_action_unsupported", "slot": "primary" }` | Operator misconfiguration; the configured provider for this slot doesn't support this action. |

## Search companies

```
POST /v1/{app_id}/people/search/company
Authorization: Bearer {token}
Content-Type: application/json

{
  "industry": "Financial Services",
  "country": "US",
  "employeeCountMax": 200,
  "pageSize": 25
}
```

Accepts the same `query` field as `search/person`. When `query` is set it takes priority over structured filters.

| Field | Type |
|---|---|
| `query` | string — optional free-form natural-language description |
| `industry` | string |
| `country` | string |
| `employeeCountMax` | number |
| `pageSize` / `nextToken` | as for people search |

### Response

```json
{
  "data": {
    "results": [
      { "linkedinUrl": "https://www.linkedin.com/company/inwestco/", "name": "InwestCo", "industry": "Financial Services", "country": "US", "employeeCount": 187 }
    ],
    "nextPage": null,
    "totalResultCount": 94950
  },
  "usage": { "creditsConsumed": 7, "usdCost": 0.007, "usdCharged": 0.0084 }
}
```

### Errors

Same error table as `search/person` above.

## Get a profile (cached)

```
POST /v1/{app_id}/people/profile
Authorization: Bearer {token}
Content-Type: application/json

{
  "linkedinProfileUrl": "https://www.linkedin.com/in/jane-doe-abc123"
}
```

| Field | Type | Notes |
|---|---|---|
| `linkedinProfileUrl` | string | Required. Normalized server-side (lowercase host/path, trim trailing slash, strip query). |
| `liveFetch` | `"force"` | Skip cache and force a live provider call. |

### Cache behavior

The first call against a given normalized URL hits the configured profile provider (~2s) and writes the result into `people_profile_cache`. Subsequent calls within the TTL are served from cache (typically <30ms) at **$0 cost**.

| Result | TTL |
|---|---|
| `ok` (profile returned) | 30 days |
| `not_found` (provider returned 404) | 7 days |
| `failed` (transient error) | 1 hour — treated as a cache miss; allows retry |

### Response — cache miss

```json
{
  "data": {
    "publicIdentifier": "jane-doe-abc123",
    "firstName": "Jane",
    "lastName": "Doe",
    "fullName": "Jane Doe",
    "headline": "VP at InwestCo",
    "occupation": "VP at InwestCo",
    "summary": "…",
    "city": "New York", "state": "NY", "country": "US",
    "experiences": [ "…" ],
    "education": [ "…" ]
  },
  "status": "ok",
  "usage": { "creditsConsumed": 2, "usdCost": 0.040, "usdCharged": 0.040, "cached": false }
}
```

### Response — cache hit

```json
{
  "data": { "…": "same shape as above" },
  "status": "ok",
  "usage": { "creditsConsumed": 0, "usdCost": 0, "usdCharged": 0, "cached": true }
}
```

### Response — not found

```json
{
  "data": null,
  "status": "not_found",
  "usage": { "creditsConsumed": 0, "usdCost": 0, "usdCharged": 0, "cached": false }
}
```

### Errors

Error codes: same as [Search people](#search-people).

## Queue an async work-email lookup

Work-email lookups are asynchronous — the platform queues the request and waits for a provider webhook callback.

```
POST /v1/{app_id}/people/profile/email
Authorization: Bearer {token}
Content-Type: application/json

{
  "linkedinProfileUrl": "https://www.linkedin.com/in/jane-doe-abc123"
}
```

### Response

```json
{
  "lookupId": "0e9796cf-0b54-4d49-9fbd-80ad2a3468ae",
  "status": "pending",
  "usage": { "creditsConsumed": 3 }
}
```

Save the `lookupId` and poll `GET /email-lookup/{lookup_id}` until `status === "resolved"`.

### Errors

Error codes: same as [Search people](#search-people).

## Poll an email lookup

```
GET /v1/{app_id}/people/email-lookup/{lookup_id}
Authorization: Bearer {token}
```

```json
{
  "status": "pending" | "resolved" | "failed" | "expired",
  "email": "jane.doe@inwestco.com" | null,
  "credits_consumed": 1
}
```

`email` is populated once the webhook fires. `credits_consumed` is the total billed across the queue + resolve flow.

### Errors

Error codes: same as [Search people](#search-people).

## Audit trail

Every successful call (and every provider-thrown failure) writes a row to `people_usage_logs`:

| Column | Notes |
|---|---|
| `action` | `search_person`, `search_company`, `profile`, `profile_cache_hit`, `profile_email_queue`, `profile_email_resolved`, plus `*_error` for failures. |
| `credits_consumed` | Provider credits used. |
| `usd_cost` | What Butterbase owes the provider. |
| `usd_charged` | What was deducted from the user (may be less if balance ran out mid-call). |
| `response_status` | Provider HTTP status. |
| `linkedin_url` | When applicable. |
| `created_at` | |

Query directly via `manage_data` / `select_rows` MCP tools for usage analytics in your CRM.

## Notes

- Searches return 0 credits charged when there are 0 results.
- Cache hits don't count against the credit balance.
- `profile/email` returns 503 if async email lookups aren't enabled on this deployment. Async email lookups resolve over time. The platform handles vendor callbacks server-side; poll the `GET /people/email-lookup/{id}` endpoint to check status.
