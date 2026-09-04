# EnrichLayer API Recon

**Date:** 2026-06-29
**Method:** 12 live probes against `https://enrichlayer.com/api/v2/` with a real API key.
**Credit usage:** 28 credits consumed (balance 20,004 → 19,976). Search results cost 3 credits each; per-result, not per-query.

## Auth & base URL

- Base: `https://enrichlayer.com/api/v2`
- Header: `Authorization: Bearer <key>`
- Bad key → `401` `{"code":401,"description":"Invalid API key","name":"Unauthorized"}`

## Endpoints confirmed working

| Endpoint | Purpose | Sync? |
|---|---|---|
| `GET /credit-balance` | Check remaining credits | ✅ sync |
| `GET /search/person` | Discover people via structured filters | ✅ sync |
| `GET /search/company` | Discover companies via structured filters | ✅ sync |
| `GET /profile` | Enrich a person by LinkedIn URL | ✅ sync |
| `GET /profile/email` | Look up work email by LinkedIn URL | ⚠️ **async** |

## Person Search — input

**Structured filters only.** No free-text `q` parameter:
```
{ "error": "Invalid input parameters",
  "invalid_fields": {"q": "Parameter 'q' is not recognized"} }
```

Confirmed filter fields:
- `current_role_title`, `past_role_title`
- `current_company_name`, `current_company_industry`
- `country`, `region`, `city`
- `page_size`, pagination via `next_token`

**Boolean syntax works** inside fields:
```
current_role_title = (CTO OR "VP Engineering") AND NOT intern
→ 27,386 matches
```

## Person Search — output shape

**Default (cheap):** only LinkedIn URLs.
```json
{
  "results": [
    { "linkedin_profile_url": "https://...", "profile": null, "last_updated": null }
  ],
  "next_page": "https://enrichlayer.com/api/v2/search/person?...&next_token=...",
  "total_result_count": 1380
}
```

**With `enrich_profiles=enrich`:** full profile inlined per result. This is the key option — collapses search + enrichment into one call.

Profile fields returned:
- Identity: `public_identifier`, `first_name`, `last_name`, `full_name`, `headline`, `occupation`, `summary`
- Location: `city`, `state`, `country`, `country_full_name`, `location_str`
- Career: `experiences[]` (each with company name, LinkedIn URL, title, dates, description, location, logo), `education[]`, `certifications[]`
- Profile: `profile_pic_url`, `background_cover_image_url`, `follower_count`, `connections`
- Misc: `languages[]`, `accomplishment_*` (publications, honors, patents, courses, projects, test scores), `volunteer_work[]`, `people_also_viewed[]`
- **`personal_emails: []`** (empty in our test — see Email section)
- **`extra.{github,twitter,facebook,website}`** when `extra=include` passed
- **No `work_email` field anywhere in profile** — must use separate endpoint

## Work Email Lookup — the gotcha

`GET /profile/email?linkedin_profile_url=...` returns **immediately** with:
```json
{ "email_queue_count": 1,
  "notes": "See the Work Email Lookup Logs for the results here: https://enrichlayer.com/dashboard/email-lookup-logs" }
```

Response does **NOT contain the email**. The lookup is queued and resolved later.

**Two ways to receive the result:**
1. **`callback_url=<webhook>`** parameter — they POST the resolved email to your URL. Confirmed accepted.
2. **Poll the dashboard logs URL.** No documented API for retrieving the log programmatically (would need scraping). Webhook is the only sane production path.

**Architectural impact:** our `lead-search` function can't return email synchronously. Either:
- Wait until user "Adds to list" → fire async email request with webhook → set person record's email when webhook fires
- Or queue and show "Email pending" state in UI

## Company Search

Same shape as person search — returns LinkedIn URLs by default, supports `enrich_profiles=enrich` for inline data. Tested filters: `industry`, `country`, `employee_count_max`. Returned 94,950 matches for "Financial Services / US / ≤200 employees."

## Edge cases

- **Zero matches:** `{ "results": [], "next_page": null, "total_result_count": 0 }` — clean empty response, no credit charge for zero results.
- **Bad query field:** `400 { "error": "Invalid input parameters", "invalid_fields": {...} }`
- **Bad auth:** `401 { "code": 401, "description": "Invalid API key", "name": "Unauthorized" }`

## Credit cost summary (observed)

| Operation | Credits | Source |
|---|---|---|
| Empty search | 0 | observed |
| `/credit-balance` | 0 | observed |
| `/profile` enrichment by URL | **2** | observed (header) |
| Person search, default (URL only) | 3 per result returned | docs + observed |
| Person search, 2 results | 6 total | observed (header) |
| Person search, `enrich_profiles=enrich` | 3 + N per result | docs (not re-verified) |
| Work email lookup queue accept | tiny on queue, billed on resolution | inferred |

12 probes ≈ 28 credits ≈ $0.06 at the smallest pack ($10/100 credits).

## Per-call cost reporting (key finding for billing passthrough)

**Every response includes the exact credit cost in a header:**

```
x-enrichlayer-credit-cost: 6
```

This is the *only* per-call cost surface — there are no `/usage` or `/billing` endpoints (both 404). The header is observed on both search and profile endpoints. Empty searches return `x-enrichlayer-credit-cost: 0`.

**Why this matters:** we can meter precisely inline without polling.

```ts
const res = await fetch(`${BASE}/search/person?${q}`, {
  headers: { Authorization: `Bearer ${apiKey}` }
});
const credits = Number(res.headers.get('x-enrichlayer-credit-cost') ?? 0);
const usd = credits * USD_PER_CREDIT;  // $0.022 at the $1k pack
await ctx.substrate.appendAction('lead_search.charge', { credits, usd, query, workspace_id });
```

**Open question:** the async work-email endpoint returns immediately with `email_queue_count: 1`. The `x-enrichlayer-credit-cost` on that initial response is small / zero (the actual lookup hasn't run yet). When the webhook fires with the resolved email, does that POST carry a cost header? Or does the cost just appear in dashboard logs? Needs end-to-end verification before relying on header-based billing for email lookups specifically.

## Account leak (FYI, not actionable)

Successful API responses set a `PC_USER_INFO` cookie containing a base64-encoded payload that decodes to the API-key owner's email and a referral token. Not a security finding for us — just notable that EnrichLayer's REST API conflates browser-session cookies with API-key auth.

## Cross-reference: Nira's EnrichLayer integration (prior project)

Recon of `/Users/kenneth/Documents/Nira/nira-live-assistant-backend/` — the prior project that shipped EnrichLayer in production.

### Endpoints they actually used

Only two — both sync:

| Endpoint | Direction | Notes |
|---|---|---|
| `GET /profile?linkedin_profile_url=...&use_cache=if-recent` | URL → full profile | Default cache mode chosen specifically to dodge the 9-credit cost of `live_fetch=force` |
| `GET /profile/resolve/email?email=...&lookup_depth=deep&enrich_profile=true` | **email → LinkedIn URL + profile** | Sync blocking call — different endpoint than `/profile/email` |

**Important nuance for our Lead Finder:** Nira's email-related flow starts from an *email they already had* (meeting attendee, signup, calendar invite). They never needed email discovery from a query. `/profile/resolve/email` is sync but it's the reverse direction — won't help us. The async `/profile/email` problem still stands for our use case.

### Files

- `app/utils/attendee_enrichment.py` — core wrapper: `enrich_by_linkedin_url`, `enrich_by_email`, LLM field extraction, Exa reconciliation
- `app/services/enrichment_service.py` — cache layer + freshness rules
- `app/api/routes/auth_routes.py` lines 50–107 — signup-time profile backfill
- `app/db/models.py` + `alembic/versions/a7c5fde64ba6_add_enrichment_cache_table.py` — `EnrichmentCache` table
- `app/core/config.py` — env: `ENRICH_LAYER_API_KEY`

### Patterns worth stealing

1. **Cache by normalized LinkedIn URL.** Postgres table keyed by lowercased, query-stripped, trailing-slash-trimmed URL. **30 days TTL for success, 7 days for not_found/failed.** `ON CONFLICT DO UPDATE` upsert. Vendor column hardcoded `"enrichlayer"`. For us: the same idea fits cleanly as a substrate `LinkedInProfile` entity with `last_enriched_at`.

2. **Default `use_cache=if-recent` on every `/profile` call** — saves the 9-credit penalty of `live_fetch=force`. Code comment in Nira explicitly calls this out.

3. **`experiences[0]` is unreliable for current job.** EnrichLayer often puts the live role in `occupation` while `headline` is a tagline and the top of `experiences[]` is stale. Nira added `_apply_headline_authority_over_extracted` to prefer `headline`/`occupation` when they conflict with `experiences[0]`.

4. **Vendor data lags reality by weeks-to-months on job changes.** Nira layered an Exa live-page crawl + LLM reconciliation on top to override stale `current_company`. For our MVP we punt this — but the freshness ceiling is real; don't promise "real-time."

5. **LLM "is this the right person" validation was disabled** — comment in `_validate_enriched_profile` says "bypass LLM validation to prevent false rejections." Suggests adding identity-match LLM gates produced more false negatives than value.

### Patterns NOT to copy

- **No `x-enrichlayer-credit-cost` metering.** Nira tracks credits only via the EnrichLayer dashboard — no per-call ledger. We should do better; the header is right there.
- **No 401 or 429 handling.** Generic `404 → not_found`, everything else raises. Celery wraps with generic retries. For a multi-tenant CRM we need explicit 429 backoff and surface 401 as "your Apollo/EnrichLayer key is invalid, fix in Settings."
- **No `callback_url` / webhook for queued endpoints.** They never used the async work-email path, so they have no reference implementation for it. We'd be building that from scratch.

### Net for our design

- Reuse: cache-by-normalized-URL with TTL split between success and not-found.
- Reuse: `use_cache=if-recent` default, header/occupation > experiences[0] resolution.
- New: `x-enrichlayer-credit-cost` ledger + 401/429 handling.
- New: webhook receiver for async email lookup — Nira didn't solve this.

## What this means for our Lead Finder design

**Wins:**
- Boolean filter syntax is more expressive than Apollo's array-of-values
- `enrich_profiles=enrich` collapses two API calls into one — much simpler client code than Apollo's search-then-enrich flow
- Zero-result searches don't burn credits
- Clean error envelopes

**Pain points:**
- **Async email lookup is the real cost** — adds a webhook endpoint to our function list, async state on the Person record ("email_pending"), and means email never appears in initial search results
- No free tier — every probe costs real money, can't onboard cold users
- Still no native NL query → LLM translator step still required

**Net:** EnrichLayer is a credible BYOK option but the **async email flow is a meaningful architectural cost** vs Apollo's sync enrichment. If we ship Apollo-first and add EnrichLayer behind a provider interface, the interface has to accommodate "email comes later via webhook" — which actually makes the abstraction cleaner long-term (lazy enrichment naturally fits async).

## Example calls

```bash
# Credit balance
curl -H "Authorization: Bearer $KEY" \
  https://enrichlayer.com/api/v2/credit-balance

# Search (cheap, URL-only)
curl -G -H "Authorization: Bearer $KEY" \
  https://enrichlayer.com/api/v2/search/person \
  --data-urlencode 'current_role_title=(CTO OR "VP Engineering")' \
  --data-urlencode 'country=US' \
  --data-urlencode 'page_size=10'

# Search with inline enrichment
curl -G -H "Authorization: Bearer $KEY" \
  https://enrichlayer.com/api/v2/search/person \
  --data-urlencode 'current_role_title=VP Engineering' \
  --data-urlencode 'enrich_profiles=enrich' \
  --data-urlencode 'page_size=3'

# Work email (async, webhook delivery)
curl -G -H "Authorization: Bearer $KEY" \
  https://enrichlayer.com/api/v2/profile/email \
  --data-urlencode 'linkedin_profile_url=https://www.linkedin.com/in/...' \
  --data-urlencode 'callback_url=https://yourapp.com/enrichlayer-email-webhook'
```
