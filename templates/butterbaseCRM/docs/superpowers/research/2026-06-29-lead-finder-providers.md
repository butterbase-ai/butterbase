# Lead Finder — Provider Research

**Date:** 2026-06-29
**Feature:** Lead Finder (type a query → get people with name, email, LinkedIn → save to list)
**Requested by:** Willow

## Requirements (from Willow)

1. Returns **name + work email**. Email is essential. LinkedIn URL is nice-to-have.
2. **Pure pay-as-you-go pricing — no flat monthly minimum.** If we make 1 API call that month, we pay for 1 call. A $49/mo "Starter" floor is disqualifying.
3. Cheapest per-call wins.
4. UX: free-text search box. Translation layer (NL → structured filters) is acceptable.

## Providers evaluated

### Apollo.io

- **Monthly minimum:** No — free plan ($0) with API access included.
- **Free tier:** 75 email-enrichment credits / month. Paid plans start at $59/mo.
- **Per-call cost:** People Search is free (no credits). Email comes from a separate **People Enrichment** call, 1 credit each (~$0.03–$0.05 on paid plans).
- **Search input:** **Structured filters only.** `person_titles[]`, `person_locations[]`, `person_seniorities[]`, `organization_industries[]`, `organization_num_employees_ranges[]`, `q_organization_keyword_tags[]`, `q_keywords`.
  - Example: `{ "person_titles": ["VP Engineering"], "organization_industries": ["financial services"], "person_locations": ["New York, US"] }`
  - LLM can translate user NL query → these filters reliably. Taxonomies are well-defined.
- **Returns from Search:** name, title, company, LinkedIn URL, location. **No email** until enrichment step.
- **Composio integration:** Yes — toolkit slug `apollo`. Actions: `APOLLO_PEOPLE_SEARCH`, `APOLLO_PEOPLE_ENRICHMENT`, `APOLLO_BULK_PEOPLE_ENRICHMENT`, `APOLLO_ORGANIZATION_SEARCH`, etc. Auth is API-key only (no OAuth); user/workspace supplies their own Apollo key.
- **Verdict:** Best data quality. Free tier covers MVP. Hard ceiling at 75 enrichments/mo — beyond that, requires $59/mo plan (violates Willow's rule).

### People Data Labs (PDL)

- **Monthly minimum:** Effectively **$98/mo** — emails and phones are obfuscated on the free 100-credit tier. Pro plan unlocks them.
- **Per-call cost:** $0.28/credit monthly, $0.20/credit annual. Person Search = 1 credit per profile returned.
- **Search input:** **Structured only.** Elasticsearch DSL or SQL against PDL Person Schema. More fields, stricter than Apollo.
- **Returns:** Email available on Pro plan only.
- **Verdict:** **Disqualified.** $98/mo flat fee to access emails violates the no-flat-fee rule.

### Exa

- **Monthly minimum:** No — true PAYG on `/search`. 20k free requests/mo, then $7/1k queries ($0.007/search). $10 signup credit.
- **Per-call cost:** $0.007 per search. No native email return.
- **Search input:** **Free-text natural language.** `category: "people"` is a real documented value; biased toward LinkedIn profiles. `type: "neural"` enables semantic understanding.
  - Example: `{ "query": "VPs of engineering at fintech startups in NYC", "category": "people", "numResults": 25 }`
- **Returns:** **URLs + page snippets only.** Mostly LinkedIn profile URLs (widely reported, not officially guaranteed in docs). **No email.** Would need a separate email-finder bolted on.
- **Exa Websets:** Exa's actual lead-gen product. NL ICP → curated, AI-verified, enriched leads with structured properties. Pricing: $49/mo Core (8k credits) or $449/mo Pro — **also violates no-flat-fee rule.**
- **Verdict:** `/search` is true PAYG but doesn't return emails (the hard requirement). Websets does, but has a $49/mo floor.

### Quick checks (email-finder specialists)

| Provider | Monthly minimum | Notes |
|---|---|---|
| Hunter.io | $49/mo Starter | No true PAYG. Disqualified. |
| Findymail | $99/mo Starter | ~$0.02/verified email, no PAYG. Disqualified. |
| Anymailfinder | ~$28/mo (CA$39) | ~$0.10/verified email, monthly floor. Disqualified. |

## Ranking against Willow's criteria

1. **Apollo (free tier)** — $0/mo baseline, 75 emails/mo free, structured search + in-house enrichment. Hard ceiling at 75/mo.
2. **Exa `/search`** — true PAYG, $0.007/search, but no email return = fails primary requirement.
3. Everything else — disqualified by flat monthly minimums.

## Composio / Butterbase integration

- Composio exposes Apollo via toolkit slug `apollo` — accessible through Butterbase's `manage_integrations`.
- Auth is API-key only. End user / workspace supplies their own Apollo key.
- Suggestion submitted to Butterbase (id `2c8a5509-6fde-44e2-9488-d244bc0ada68`) asking them to host Apollo with a managed shared key, like Recall.ai. Until then, BYOK is the only path.

## Recommendation

**Apollo + LLM translator, BYOK.**

Architecture:
```
user types "VPs of eng at NYC fintechs"
   ↓
LLM (Butterbase AI gateway) → { person_titles, organization_industries, person_locations }
   ↓
APOLLO_PEOPLE_SEARCH (via Composio) → results with name/title/company/LinkedIn
   ↓
APOLLO_PEOPLE_ENRICHMENT per result → emails
   ↓
render results; user picks any to save into a list
```

**Why:**
- Only provider that meets both "returns email" and "$0 to start."
- Best data quality of the candidates.
- Single vendor — no fallback complexity.
- Free tier (75 enrichments/mo) covers MVP and most small workspaces.
- BYOK pattern matches existing Butterbase integrations (Google, social toolkits).

**Tradeoffs accepted:**
- Workspace owners must sign up with Apollo and paste their API key — onboarding friction.
- Once 75/mo free quota is exhausted, user must either upgrade Apollo or stop searching. This violates Willow's "no flat fee" rule *at scale*, but never *at start*.
- LLM translator adds ~1 AI gateway call per search (negligible cost via Butterbase AI gateway).

## Open questions

- Show users the translated filters as visible chips, or hide them?
- What happens when Apollo free quota hits 0 — block, warn, or fall through to a degraded search?
- Per-workspace cache of recent searches to avoid burning credits on repeat queries?

## Sources

- [Apollo API Pricing](https://docs.apollo.io/docs/api-pricing)
- [Apollo People API Search](https://docs.apollo.io/reference/people-api-search)
- [Apollo People Enrichment](https://docs.apollo.io/reference/people-enrichment)
- [Apollo Pricing](https://www.apollo.io/pricing)
- [Composio Apollo toolkit](https://composio.dev/toolkits/apollo) · [docs](https://docs.composio.dev/toolkits/apollo)
- [PDL Person Pricing](https://www.peopledatalabs.com/pricing/person)
- [PDL Person Search API](https://docs.peopledatalabs.com/docs/person-search-api)
- [Exa /search reference](https://exa.ai/docs/reference/search)
- [Exa pricing](https://exa.ai/pricing)
- [Exa Websets](https://exa.ai/websets)
- [Hunter Pricing](https://hunter.io/pricing)
- [Findymail Pricing](https://findymail.com/pricing)
- [Anymailfinder Pricing](https://anymailfinder.com/pricing)
