---
title: People API
description: Complete reference for the People (LinkedIn enrichment) REST endpoints — structured-filter people/company search, profile lookups, async work-email lookup, and credit metering.
sidebar:
  order: 8
---

Endpoints for finding people and companies on LinkedIn, fetching enriched profiles, and queuing async work-email lookups via Butterbase's managed People integration. Useful for Lead-Finder, CRM enrichment, and people-search features.

All endpoints are app-scoped — the `app_id` lives in the URL path and the call is authenticated with a Butterbase service-key (`bb_sk_...`) or JWT belonging to that app's owner.

Every call is metered against the user's Butterbase credit balance at platform pricing. Cache hits are free.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | /v1/\{app_id\}/people/search/person | Structured-filter search for people |
| POST | /v1/\{app_id\}/people/search/company | Structured-filter search for companies |
| POST | /v1/\{app_id\}/people/profile | Enrich a LinkedIn profile by URL (with 30-day cache) |
| POST | /v1/\{app_id\}/people/profile/email | Queue an async work-email lookup |
| GET | /v1/\{app_id\}/people/email-lookup/\{lookup_id\} | Poll a pending email lookup |
| GET | /v1/\{app_id\}/people/credit-balance | Read the platform's People credit balance |

## Response headers

Every people response (success and error) carries these headers so callers can track cost without parsing the body:

| Header | Example | Notes |
|---|---|---|
| `x-people-provider` | `primary` | Which provider slot served the call |
| `x-people-credits-consumed` | `3` | Integer |
| `x-people-usd-cost` | `0.060480` | What we owe the vendor |
| `x-people-usd-charged` | `0.060480` | What we deducted from the user |
| `x-people-cached` | `true` | Profile route only |

Headers are present on every reply path — success, cache hit, balance-gate rejection (402), and error (503/4xx). For error or balance-rejection paths, numeric headers are `0` or `0.000000`. The `x-people-cached` header appears only on the `/profile` route.

## Pricing

Costs are routed per provider slot (primary or secondary). The platform operator configures each slot's pricing independently via:
- `PEOPLE_PROVIDER_<SLOT>_BASE_USD_PER_CREDIT` — wholesale cost
- `PEOPLE_PROVIDER_<SLOT>_MARKUP_PCT` — platform margin

Action routing is controlled by one env var per action; each defaults to `primary` if unset:

| Var | Action |
|---|---|
| `PEOPLE_ROUTE_SEARCH_PERSON` | `POST /people/search/person` |
| `PEOPLE_ROUTE_SEARCH_COMPANY` | `POST /people/search/company` |
| `PEOPLE_ROUTE_GET_PROFILE` | `POST /people/profile` |
| `PEOPLE_ROUTE_QUEUE_EMAIL_LOOKUP` | `POST /people/profile/email` |

The effective rate per slot is calculated as:

```
usdPerCredit = base × (1 + markup%)
```

Each adapter response includes a credit-cost header; Butterbase reads this and charges the exact amount. Observed per-action costs (at default platform pricing):

| Action | Credits | USD @ default rate |
|---|---|---|
| `search/person` (URLs only) | 3 per result returned | $0.06 / result |
| `search/person` with `enrich_profiles=true` | 3 + N per result | ~$0.12 / result |
| `search/company` | similar to person | similar |
| `profile` (cache miss) | 2 | $0.04 |
| `profile` (cache hit) | 0 | $0 (free) |
| `profile/email` (queue accept) | 3 | $0.06 |
| Webhook callback resolving an email | 1 | $0.02 |
| `credit-balance` | 0 | $0 |
| Empty search (0 results) | 0 | $0 |

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
  "currentRoleTitle": "(VP OR \"Vice President\") AND NOT assistant",
  "educationSchoolName": "(Harvard OR Stanford OR MIT OR Princeton OR Yale)",
  "country": "US",
  "pageSize": 25
}
```

Every filter accepts People's **boolean syntax** — `OR`, `AND`, `NOT`, parenthesized groups, double-quoted phrases — so you can express things like *"VPs OR Vice Presidents (but not assistants) who attended an Ivy League school"* in a single field.

| Field | Type | Notes |
|---|---|---|
| `currentRoleTitle` | string | Current job title. Boolean syntax. |
| `pastRoleTitle` | string | Any past role. |
| `currentCompanyName` | string | |
| `currentCompanyIndustry` | string | |
| `country` | string | E.g. `US`, `GB`. |
| `region` | string | State/region. |
| `city` | string | |
| `educationSchoolName` | string | Boolean syntax — e.g. `(Harvard OR Stanford)`. |
| `educationDegreeName` | string | E.g. `MBA`, `PhD`, `MD`. |
| `educationFieldOfStudy` | string | E.g. `"Computer Science"`. |
| `pageSize` | number | 1–100. Defaults to vendor default (25). |
| `nextToken` | string | Pagination cursor from a prior response. |
| `enrichProfiles` | boolean | If `true`, inlines the full profile per result. Significantly more expensive (3 + N per result). |

### Response

```json
{
  "data": {
    "results": [
      {
        "linkedinProfileUrl": "https://www.linkedin.com/in/jane-doe-abc123",
        "profile": null,
        "lastUpdated": null
      }
    ],
    "nextPage": "https://api.platform.example.com/search/person?next_token=...",
    "totalResultCount": 8269
  },
  "usage": {
    "creditsConsumed": 3,
    "usdCost": 0.06048,
    "usdCharged": 0.06048
  }
}
```

`totalResultCount` is the vendor's count for the full filter — useful for cost-preview before paginating. `nextPage` (when present) embeds a `next_token`; extract and pass as `nextToken` on the next request.

`results[*].profile` is `null` unless you set `enrichProfiles: true` (in which case each result gets a full `ProfilePayload`).

### Errors

| HTTP | Body | When |
|---|---|---|
| 402 | `{ "error": "insufficient_credits" }` | User's total Butterbase credit balance is below the minimum gate (default $0.05). Adapter is not called. |
| 403 | `{ "error": "forbidden" }` | Authed user doesn't own the app. |
| 404 | `{ "error": "app_not_found" }` | No app with that ID. |
| 502 | `{ "error": "people_5xx" }` | Vendor returned a 5xx. |
| 503 | `{ "error": "people_disabled" }` | Feature flag is off on this deployment. |
| 503 | `{ "error": "people_unavailable" }` | Platform key not configured (no adapter registered). |

## Search companies

```
POST /v1/{app_id}/people/search/company
Content-Type: application/json

{
  "industry": "Financial Services",
  "country": "US",
  "employeeCountMax": 200,
  "pageSize": 25
}
```

| Field | Type |
|---|---|
| `industry` | string |
| `country` | string |
| `employeeCountMax` | number |
| `pageSize` / `nextToken` / `enrichProfiles` | as for people search |

### Response

```json
{
  "data": {
    "results": [
      { "linkedinUrl": "...", "name": "...", "industry": "...", "country": "...", "employeeCount": 187 }
    ],
    "nextPage": null,
    "totalResultCount": 94950
  },
  "usage": { "creditsConsumed": 3, "usdCost": 0.06048, "usdCharged": 0.06048 }
}
```

## Get a profile (cached)

```
POST /v1/{app_id}/people/profile
Content-Type: application/json

{
  "linkedinProfileUrl": "https://www.linkedin.com/in/jane-doe-abc123"
}
```

| Field | Type | Notes |
|---|---|---|
| `linkedinProfileUrl` | string | Required. Will be normalized server-side (lowercase host/path, trim trailing slash, strip query). |
| `liveFetch` | `"force"` | Skip cache and force a live vendor call. |

### Cache behavior

The first call against a given normalized URL hits the vendor (~2s) and writes the result into `people_profile_cache`. Subsequent calls within the TTL are served from cache (typically <30ms) at **$0 cost**.

| Result | TTL |
|---|---|
| `ok` (profile returned) | 30 days |
| `not_found` (vendor returned 404) | 7 days |
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
    "experiences": [ … ],
    "education": [ … ],
    "raw": { /* verbatim vendor payload */ }
  },
  "status": "ok",
  "usage": { "creditsConsumed": 2, "usdCost": 0.04032, "usdCharged": 0.04032, "cached": false }
}
```

### Response — cache hit

```json
{
  "data": { /* same shape as above */ },
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

## Queue an async work-email lookup

People doesn't return work emails inline. You queue the lookup and Butterbase waits for People's webhook callback.

```
POST /v1/{app_id}/people/profile/email
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

## Credit balance (platform-side passthrough)

```
GET /v1/{app_id}/people/credit-balance
```

```json
{ "balance": 19962 }
```

This is the platform's People-side credit balance — **not** the user's Butterbase credit balance. Useful for ops dashboards. Doesn't deduct user credits.

## Audit trail

Every successful call (and every adapter-thrown failure) writes a row to `people_usage_logs`:

| Column | Notes |
|---|---|
| `action` | `search_person`, `search_company`, `profile`, `profile_cache_hit`, `profile_email_queue`, `profile_email_resolved`, plus `*_error` for failures. |
| `credits_consumed` | Vendor credits used. |
| `usd_cost` | What Butterbase owes the vendor. |
| `usd_charged` | What was deducted from the user (may be less if balance ran out mid-call). |
| `response_status` | Vendor HTTP status. |
| `linkedin_url` | When applicable. |
| `created_at` | |

Query directly via `manage_data` / `select_rows` MCP tools for usage analytics in your CRM.

## Notes

- Searches return 0 credits charged when there are 0 results (vendor doesn't bill).
- Cache hits don't count against the People credit pool.
- `profile/email` returns 503 if `PEOPLE_WEBHOOK_HOST_URL` isn't configured — async lookups can't deliver without a public callback URL.
- The webhook receiver at `POST /v1/webhooks/people/email?nonce=...` is unauthenticated by design; the 32-byte nonce serves as the auth gate. People's callback domain should be allow-listed at the load-balancer if you want defense in depth.
