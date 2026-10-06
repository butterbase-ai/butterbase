# Lead Finder Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the provider-agnostic Lead Finder scaffolding — substrate entity types, backend functions returning mock data, frontend `/leads` page, and add-to-list flow — so the moment Butterbase ships managed Apollo, we swap one branch in `lead-search/handler.ts` and ship.

**Architecture:** Three new substrate entity types (`saved_search`, `lead_list`, `lead_finder_cache`), four new backend functions (`lead-search`, `lead-cost-preview`, `lead-save`, `saved-searches`), one new frontend route (`/leads`). The `lead-search` function today returns deterministic mock data shaped to match Apollo's eventual response. When managed Apollo lands, the mock branch is replaced with an HTTP call to `/v1/:appId/apollo/search/person`; everything downstream stays.

**Tech Stack:** Butterbase serverless functions (TypeScript, `ctx.substrate`), React + Vite + Tailwind + shadcn (Radix primitives, lucide icons, react-router-dom v6), `@butterbase/sdk` (`bb.functions.invoke`).

## Global Constraints

- **No git in this repo.** Skip all `git commit` / `git add` steps. Replace with deploy + smoke.
- **No tests in this codebase.** Verification = deploy the function, invoke it via `invoke_function`, eyeball the JSON; for frontend, run `npm run dev` and click through.
- **Backend function structure:** each function is `backend/functions/<name>/{function.json, handler.ts}`. `function.json` declares `auth` (`required` or `optional`), `timeoutMs`, `memoryLimitMb`. The handler exports `async function handler(req, ctx)` and returns a `Response`.
- **Functions calling other functions:** use `ctx.invoke(fnName, body, { headers: { 'x-butterbase-as-user': userId } })`. Targets should be `auth: optional`.
- **Frontend invoke pattern:** `await bb.functions.invoke('fn-name', { body: {...} })`. Returns `{ data, error }`.
- **Sidebar entries** are pure data in `frontend/src/components/Sidebar.tsx` — add an object to the `items` array.
- **Routes** are declared in `frontend/src/routes/index.tsx` inside the `<AppShell />` block.
- **Substrate entity types are a FIXED ENUM:** `person | company | fund | workspace | team | project | event | agent | self`. Do NOT invent new types; they get rejected.
- **Substrate `upsert_entity` payload** requires `{ type, display_name, canonical_keys?, attrs?, primary_email? }`. `display_name` is REQUIRED on every upsert.
- **Substrate `patch_entity` payload** uses `{ id, attrs_patch, display_name? }` — NOT `{ entity_id, attrs }`. `attrs_patch` is RFC 7396 merge-patch over the existing attrs.
- **Substrate `delete_entity` is approval-gated** — for routine deletes use soft-delete via `patch_entity` setting `attrs_patch: { deleted_at: <iso> }` and filter `attrs.deleted_at == null` on read.
- **Storage layer chosen per data shape:**
  - `lead_finder_cache` → **`ctx.kv`** (native TTL fit). Key `leadcache:{queryHash}`. TTL 24h = 86400 seconds.
  - `saved_search` → **`ctx.kv`** with per-user prefix `savedsearch:{userId}:{slug}`. List via prefix; delete via `kv.del` (no soft-delete needed for KV).
  - `lead_list` → **substrate** `type: 'project'` with `attrs.kind: 'lead_list'` (so cross-app substrate viewers see them). Filter by `attrs.kind === 'lead_list'` on read.
  - `person` and `company` saved from results → **substrate** (their native types, dedupes via canonical_keys).
- **`ctx.kv` API** (confirmed via existing codebase): `await ctx.kv.get<T>(key) // T | null`, `await ctx.kv.set(key, value, { ttl })` // ttl in seconds, `await ctx.kv.del(key)`, `await ctx.kv.setnx(key, v, { ttl })` returns boolean. For listing by prefix, use the MCP `manage_kv list_keys` pattern — if `ctx.kv.list` is unavailable inside the function runtime, fall back to maintaining an index key (e.g. `savedsearch:{userId}:_index` JSON array of slugs).
- **No `Checkbox` component** in `frontend/src/components/ui/`. Use native `<input type="checkbox" />` with Tailwind classes (no new dependency).
- **Mock data must be deterministic** keyed off the filter object so the same search returns the same results twice.

---

## File structure

### New backend files
- `backend/functions/lead-search/function.json` — `auth: required`, 30s timeout
- `backend/functions/lead-search/handler.ts` — orchestrates LLM-translate → cache-check → provider call (mock today) → cache-write
- `backend/functions/lead-cost-preview/function.json` — `auth: required`
- `backend/functions/lead-cost-preview/handler.ts` — returns deterministic mock cost for N selected results
- `backend/functions/lead-save/function.json` — `auth: required`
- `backend/functions/lead-save/handler.ts` — materializes selected results into `person` + `company` substrate entities, optionally appends to a `lead_list`
- `backend/functions/saved-searches/function.json` — `auth: required`
- `backend/functions/saved-searches/handler.ts` — list / create / update / delete on `saved_search` substrate entities

### New frontend files
- `frontend/src/pages/LeadFinder.tsx` — page shell, search box, results table, dialog wiring
- `frontend/src/components/LeadSearchBox.tsx` — input + filter chips
- `frontend/src/components/LeadResultsTable.tsx` — table with checkboxes, masked emails, per-row reveal button
- `frontend/src/components/AddToListDialog.tsx` — cost preview + confirm flow
- `frontend/src/components/SavedSearchesPanel.tsx` — saved searches sidebar within Lead Finder

### Modified frontend files
- `frontend/src/components/Sidebar.tsx` — add `Lead Finder` nav item
- `frontend/src/routes/index.tsx` — register `/leads` route

### Substrate entity types (declarative, no migration files — substrate is schemaless)
- `saved_search` — persisted user searches
- `lead_list` — collection of person entities saved from Lead Finder
- `lead_finder_cache` — short-TTL search result cache keyed by filter-hash

---

## Task 1: Mock data shape + filter hash utility

A pure-TS helper module that both `lead-search` and `lead-cost-preview` import. Defines the `SearchResult` interface, the masked-email synthesizer, the filter-hash canonicalizer, and the deterministic mock generator. Pulled out so we can replace just the provider branch later without touching shape definitions.

**Files:**
- Create: `backend/functions/lead-search/lib.ts`

**Interfaces:**
- Produces:
  - `interface SearchFilters { titles?: string[]; industries?: string[]; locations?: string[]; seniorities?: string[]; company_sizes?: string[] }`
  - `interface SearchResult { external_id: string; full_name: string; first_name?: string; last_name?: string; title?: string; company_name?: string; company_domain?: string; linkedin_url?: string; location?: string; email_masked?: string; email?: string; email_status?: 'masked' | 'verified' | 'guessed' | 'pending' | 'unknown' }`
  - `function hashFilters(f: SearchFilters): string` — deterministic SHA-256 hex over sorted keys
  - `function maskEmail(firstName: string | undefined, companyDomain: string | undefined, companyName: string | undefined): string`
  - `function mockSearch(filters: SearchFilters, pageSize: number, cursor?: string): { results: SearchResult[]; next_cursor?: string; total_count: number }`

- [ ] **Step 1: Create the file with interfaces and `hashFilters`**

```ts
// backend/functions/lead-search/lib.ts
export interface SearchFilters {
  titles?: string[];
  industries?: string[];
  locations?: string[];
  seniorities?: string[];
  company_sizes?: string[];
}

export interface SearchResult {
  external_id: string;
  full_name: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  company_name?: string;
  company_domain?: string;
  linkedin_url?: string;
  location?: string;
  email_masked?: string;
  email?: string;
  email_status?: 'masked' | 'verified' | 'guessed' | 'pending' | 'unknown';
}

function canonical(f: SearchFilters): string {
  const sorted: Record<string, string[]> = {};
  for (const k of Object.keys(f).sort()) {
    const v = (f as any)[k];
    if (Array.isArray(v) && v.length) sorted[k] = [...v].map((s) => String(s).toLowerCase()).sort();
  }
  return JSON.stringify(sorted);
}

export async function hashFilters(f: SearchFilters): Promise<string> {
  const data = new TextEncoder().encode(canonical(f));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 2: Add `maskEmail` helper**

```ts
export function maskEmail(
  firstName: string | undefined,
  companyDomain: string | undefined,
  companyName: string | undefined,
): string {
  const initial = (firstName ?? '?').trim().charAt(0).toLowerCase() || '?';
  let domain = companyDomain?.trim().toLowerCase();
  if (!domain && companyName) {
    domain = companyName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') + '.com';
  }
  if (!domain) domain = 'company.com';
  return `${initial}****@${domain}`;
}
```

- [ ] **Step 3: Add the deterministic mock generator**

The generator takes filters + page_size + optional cursor and synthesizes plausible-looking people. It must be deterministic on `(filters, cursor)` so that the same query returns the same people every time — that's how cache lookups will work later.

```ts
const FIRST = ['Matthew','Jane','Wayne','Priya','Alex','Sam','Rita','Diego','Hannah','Olu','Mei','Carlos','Anya','Theo','Yuki'];
const LAST  = ['Grant','Davis','Fong','Patel','Kim','Sanchez','Cohen','Mendez','Larsson','Adeyemi','Tanaka','Reyes','Ivanova','Park','Sato'];
const COMPANIES = [
  { name: 'American Express', domain: 'aexp.com' },
  { name: 'Stripe',           domain: 'stripe.com' },
  { name: 'Plaid',            domain: 'plaid.com' },
  { name: 'Brex',             domain: 'brex.com' },
  { name: 'Ramp',             domain: 'ramp.com' },
  { name: 'Chime',            domain: 'chime.com' },
  { name: 'Mercury',          domain: 'mercury.com' },
  { name: 'Wise',             domain: 'wise.com' },
];

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export function mockSearch(
  filters: SearchFilters,
  pageSize: number,
  cursor?: string,
): { results: SearchResult[]; next_cursor?: string; total_count: number } {
  const seedStr = canonical(filters) + '|' + (cursor ?? '0');
  const startSeed = fnv1a(seedStr);
  const titleHints = filters.titles?.[0] ?? 'VP Engineering';
  const locHint = filters.locations?.[0] ?? 'United States';

  const offset = cursor ? Number(cursor) : 0;
  const total = 1000 + (startSeed % 500);
  const remaining = Math.max(0, total - offset);
  const take = Math.min(pageSize, remaining);

  const results: SearchResult[] = [];
  for (let i = 0; i < take; i++) {
    const seed = fnv1a(seedStr + ':' + i);
    const first = FIRST[seed % FIRST.length];
    const last  = LAST[(seed >>> 8) % LAST.length];
    const comp  = COMPANIES[(seed >>> 16) % COMPANIES.length];
    const fullName = `${first} ${last}`;
    const linkedinSlug = `${first}-${last}-${(seed % 9999).toString().padStart(4, '0')}`.toLowerCase();
    results.push({
      external_id: `https://www.linkedin.com/in/${linkedinSlug}`,
      full_name: fullName,
      first_name: first,
      last_name: last,
      title: titleHints,
      company_name: comp.name,
      company_domain: comp.domain,
      linkedin_url: `https://www.linkedin.com/in/${linkedinSlug}`,
      location: locHint,
      email_masked: maskEmail(first, comp.domain, comp.name),
      email_status: 'masked',
    });
  }
  const next = offset + take < total ? String(offset + take) : undefined;
  return { results, next_cursor: next, total_count: total };
}
```

- [ ] **Step 4: Smoke-test the helper inline by adding a temporary harness**

There's no test runner — paste this into a scratch file and `node` it, or just `console.log` invoke once after deploy. Keep it short.

```ts
// Sanity (delete after eyeballing):
// import { mockSearch, maskEmail, hashFilters } from './lib';
// console.log(JSON.stringify(mockSearch({ titles: ['VP Engineering'], locations: ['NYC'] }, 3)));
// console.log(maskEmail('Matthew', undefined, 'American Express'));
// console.log(await hashFilters({ titles: ['CTO'] }));
```

Verify the same filter object returns the same names twice and `email_masked` looks like `m****@aexp.com`.

- [ ] **Step 5: Deploy + smoke (deferred to Task 2)** — `lib.ts` doesn't deploy on its own. Move on.

---

## Task 2: `lead-search` function — orchestration with mock provider

The end-to-end search function. Validates body → optional LLM translate (skipped today; passes `filters` straight through) → cache lookup → mock provider → cache write → return.

The LLM-translate branch is wired-but-skipped for v1 — we accept the `filters` directly from the frontend (the frontend builds chips that the user edits, so structured input is already available). When ready for free-text input, swap in `ctx.ai.chat(...)`.

**Files:**
- Create: `backend/functions/lead-search/function.json`
- Create: `backend/functions/lead-search/handler.ts`

**Interfaces:**
- Consumes: `SearchFilters`, `SearchResult`, `hashFilters`, `mockSearch` from Task 1
- Produces:
  - HTTP POST body: `{ query?: string; filters: SearchFilters; page_size?: number; cursor?: string }`
  - HTTP response: `{ results: SearchResult[]; filters: SearchFilters; total_count: number; next_cursor?: string; query_hash: string; provider: 'mock' | 'apollo'; from_cache: boolean }`

- [ ] **Step 1: Create `function.json`**

```json
{
  "name": "lead-search",
  "description": "Search for leads by structured filters. Returns ranked people with masked emails. Mock provider today; Apollo when managed integration ships.",
  "triggers": [
    { "type": "http", "config": { "auth": "required" }, "enabled": true }
  ],
  "timeoutMs": 30000,
  "memoryLimitMb": 256,
  "agent_tool": false
}
```

- [ ] **Step 2: Write the handler**

Storage: cache lives in `ctx.kv` keyed by `leadcache:{queryHash}` with 24h TTL. No substrate involvement on this function.

```ts
// backend/functions/lead-search/handler.ts
import { hashFilters, mockSearch, type SearchFilters, type SearchResult } from './lib';

const CACHE_TTL_SEC = 24 * 60 * 60; // 24h
const cacheKey = (h: string) => `leadcache:${h}`;

interface CacheBlob {
  query_hash: string;
  filters: SearchFilters;
  results: SearchResult[];
  next_cursor?: string;
  total_count: number;
  provider: 'mock' | 'apollo';
  cached_at: string;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sanitizeFilters(raw: any): SearchFilters {
  const out: SearchFilters = {};
  const arr = (v: any) => Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 20) : undefined;
  out.titles        = arr(raw?.titles);
  out.industries    = arr(raw?.industries);
  out.locations     = arr(raw?.locations);
  out.seniorities   = arr(raw?.seniorities);
  out.company_sizes = arr(raw?.company_sizes);
  for (const k of Object.keys(out)) if ((out as any)[k] === undefined) delete (out as any)[k];
  return out;
}

export async function handler(req: Request, ctx: any) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const filters = sanitizeFilters(body?.filters);
  if (!filters.titles?.length && !filters.industries?.length && !filters.locations?.length && !filters.seniorities?.length) {
    return json(400, { error: 'filters_empty', detail: 'Provide at least one of titles, industries, locations, seniorities' });
  }

  const pageSize = Math.min(Math.max(Number(body?.page_size) || 25, 1), 100);
  const cursor: string | undefined = typeof body?.cursor === 'string' ? body.cursor : undefined;

  const queryHash = await hashFilters(filters);

  // Cache lookup (first page only)
  if (!cursor) {
    try {
      const hit = await ctx.kv.get<CacheBlob>(cacheKey(queryHash));
      if (hit && hit.query_hash === queryHash) {
        return json(200, {
          results: hit.results.slice(0, pageSize),
          filters,
          total_count: hit.total_count,
          next_cursor: hit.next_cursor,
          query_hash: queryHash,
          provider: hit.provider,
          from_cache: true,
        });
      }
    } catch { /* cache miss is non-fatal */ }
  }

  // === PROVIDER BRANCH — replace this block when managed Apollo lands ===
  const { results, next_cursor, total_count } = mockSearch(filters, pageSize, cursor);
  const provider: 'mock' | 'apollo' = 'mock';
  // === END PROVIDER BRANCH ===

  // Cache write (first page only)
  if (!cursor) {
    const blob: CacheBlob = {
      query_hash: queryHash,
      filters,
      results,
      next_cursor,
      total_count,
      provider,
      cached_at: new Date().toISOString(),
    };
    try { await ctx.kv.set(cacheKey(queryHash), blob, { ttl: CACHE_TTL_SEC }); } catch { /* non-fatal */ }
  }

  return json(200, {
    results,
    filters,
    total_count,
    next_cursor,
    query_hash: queryHash,
    provider,
    from_cache: false,
  });
}
```

- [ ] **Step 3: Deploy via Butterbase MCP**

Use `mcp__butterbase__deploy_function` with `app_id=app_44zjayftl7b3`, `function_dir=backend/functions/lead-search`. Expected: returns `{ success: true, function_name: 'lead-search' }`.

- [ ] **Step 4: Smoke-test with `invoke_function`**

```
mcp__butterbase__invoke_function
  app_id: app_44zjayftl7b3
  function_name: lead-search
  body: { "filters": { "titles": ["VP Engineering"], "locations": ["New York"] }, "page_size": 5 }
```

Expected: 200, `results.length === 5`, every result has `email_masked` like `m****@<domain>`, `from_cache: false`. Invoke a second time with identical body → `from_cache: true`, same `results`.

- [ ] **Step 5: Edge-case smoke**

```
body: { "filters": {} }                            → expect 400 filters_empty
body: { "filters": { "titles": ["CTO"] }, "page_size": 200 }  → expect 200, page_size clamped to 100
```

---

## Task 3: `lead-cost-preview` function — mock cost calculator

Returns a deterministic mock cost for a set of selected results. Today uses fixed per-action constants. When Apollo ships, swap in real pricing from the managed-Apollo response or a config lookup.

**Files:**
- Create: `backend/functions/lead-cost-preview/function.json`
- Create: `backend/functions/lead-cost-preview/handler.ts`

**Interfaces:**
- Produces:
  - HTTP body: `{ result_ids: string[]; reveal_emails: boolean }`
  - HTTP response: `{ credits: number; usd_estimate: number; balance_after?: number; reveal_emails: boolean; per_unit: { search_credit: number; email_credit: number; usd_per_credit: number } }`

- [ ] **Step 1: Create `function.json`**

```json
{
  "name": "lead-cost-preview",
  "description": "Return a cost estimate for revealing emails on N selected lead results. Pure-read, no side effects.",
  "triggers": [
    { "type": "http", "config": { "auth": "required" }, "enabled": true }
  ],
  "timeoutMs": 5000,
  "memoryLimitMb": 64,
  "agent_tool": false
}
```

- [ ] **Step 2: Write the handler**

```ts
// backend/functions/lead-cost-preview/handler.ts
// Constants tuned to Apollo's expected retail. Replace at integration time.
const SEARCH_CREDIT = 0;     // Apollo search is free
const EMAIL_CREDIT = 1;      // Apollo enrichment = 1 credit per result
const USD_PER_CREDIT = 0.05; // user-facing rate; adjust when Butterbase pricing lands

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function handler(req: Request, ctx: any) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const ids: string[] = Array.isArray(body?.result_ids) ? body.result_ids.filter((s: any) => typeof s === 'string') : [];
  const reveal = !!body?.reveal_emails;
  const n = ids.length;
  if (n === 0) return json(400, { error: 'no_results_selected' });

  const credits = reveal ? n * EMAIL_CREDIT : n * SEARCH_CREDIT;
  const usd = +(credits * USD_PER_CREDIT).toFixed(4);

  return json(200, {
    credits,
    usd_estimate: usd,
    reveal_emails: reveal,
    per_unit: {
      search_credit: SEARCH_CREDIT,
      email_credit: EMAIL_CREDIT,
      usd_per_credit: USD_PER_CREDIT,
    },
  });
}
```

- [ ] **Step 3: Deploy + smoke**

```
mcp__butterbase__deploy_function  app_id=app_44zjayftl7b3  function_dir=backend/functions/lead-cost-preview
mcp__butterbase__invoke_function  function_name=lead-cost-preview
  body: { "result_ids": ["a","b","c"], "reveal_emails": true }
```

Expected: `{ credits: 3, usd_estimate: 0.15, reveal_emails: true, ... }`.

```
body: { "result_ids": ["a","b","c"], "reveal_emails": false }   → credits: 0
body: { "result_ids": [] }                                       → 400 no_results_selected
```

---

## Task 4: `lead-save` function — materialize results into CRM

Takes the cached search results + selected `external_id`s + a target list, creates/updates `person` substrate entities (using `external_id` as the canonical key), creates/updates parent `company` entities, and appends the people to a `lead_list` entity. If `reveal_emails: true`, sets `email_status: 'pending'` (today we never resolve since there's no real provider; when Apollo ships we set the real email synchronously).

**Files:**
- Create: `backend/functions/lead-save/function.json`
- Create: `backend/functions/lead-save/handler.ts`

**Interfaces:**
- Consumes: cached `SearchResult` shape from Task 2
- Produces:
  - HTTP body: `{ query_hash: string; result_ids: string[]; list_id?: string; new_list_name?: string; reveal_emails: boolean }`
  - HTTP response: `{ saved_count: number; list_id: string; person_ids: string[]; pending_email_count: number; revealed_email_count: number }`

- [ ] **Step 1: Create `function.json`** (same shape as Task 2, `auth: required`, `timeoutMs: 30000`, `memoryLimitMb: 256`).

```json
{
  "name": "lead-save",
  "description": "Materialize selected lead-search results into CRM person/company substrate entities and append to a lead_list.",
  "triggers": [
    { "type": "http", "config": { "auth": "required" }, "enabled": true }
  ],
  "timeoutMs": 30000,
  "memoryLimitMb": 256,
  "agent_tool": false
}
```

- [ ] **Step 2: Write the handler — pull cache + validate body**

```ts
// backend/functions/lead-save/handler.ts
const cacheKey = (h: string) => `leadcache:${h}`;

interface CachedResult {
  external_id: string;
  full_name: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  company_name?: string;
  company_domain?: string;
  linkedin_url?: string;
  location?: string;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function extractEntityId(verdict: any): string | null {
  if (!verdict) return null;
  return verdict.result?.entity_id ?? verdict.entity_id ?? verdict.id ?? verdict.result?.id ?? null;
}

export async function handler(req: Request, ctx: any) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });
  if (!ctx.substrate) return json(503, { error: 'substrate_not_linked' });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const queryHash: string = String(body?.query_hash ?? '');
  const selected: string[] = Array.isArray(body?.result_ids) ? body.result_ids.filter((s: any) => typeof s === 'string') : [];
  const reveal = !!body?.reveal_emails;
  const listIdInput: string | undefined = typeof body?.list_id === 'string' ? body.list_id : undefined;
  const newListName: string | undefined = typeof body?.new_list_name === 'string' ? body.new_list_name : undefined;

  if (!queryHash) return json(400, { error: 'query_hash_required' });
  if (selected.length === 0) return json(400, { error: 'no_results_selected' });
  if (!listIdInput && !newListName) return json(400, { error: 'list_target_required' });

  // Pull cached results from KV
  const blob = await ctx.kv.get<{ results: CachedResult[]; query_hash: string }>(cacheKey(queryHash));
  if (!blob || blob.query_hash !== queryHash) {
    return json(410, { error: 'cache_expired', detail: 'Re-run the search before saving' });
  }
  const cached: CachedResult[] = Array.isArray(blob.results) ? blob.results : [];
  const byId = new Map(cached.map((r) => [r.external_id, r]));
  const picks = selected.map((id) => byId.get(id)).filter((p): p is CachedResult => !!p);
  if (picks.length === 0) return json(400, { error: 'selected_ids_not_in_cache' });
```

- [ ] **Step 3: Continue handler — resolve / create lead_list (as substrate `project`)**

`lead_list` is stored as substrate `type: 'project'` with `attrs.kind: 'lead_list'` so it joins the standard substrate entity model while not stepping on actual cross-app projects.

```ts
  let listId: string;
  if (listIdInput) {
    listId = listIdInput;
  } else {
    const listVerdict = await ctx.substrate.propose('upsert_entity', {
      type: 'project',
      display_name: newListName!,
      canonical_keys: { lead_finder_list_name: newListName },
      attrs: {
        kind: 'lead_list',
        name: newListName,
        created_by: ctx.user.id,
        source: 'lead_finder',
        member_external_ids: [],
        created_at: new Date().toISOString(),
      },
    });
    listId = extractEntityId(listVerdict) ?? '';
    if (!listId) return json(502, { error: 'list_create_failed' });
  }
```

- [ ] **Step 4: Continue handler — materialize each pick into person + company entities**

For each picked result:
1. Upsert `company` (legal substrate type) by `canonical_keys: { domain }` (fallback to `{ name }`). Include required `display_name`.
2. Upsert `person` (legal substrate type) by `canonical_keys: { linkedin_url }`. Include required `display_name`.
3. Track entity ids; collect into `person_ids`.
4. `email_status`: today always `'pending'` if reveal=true (no provider). When Apollo ships, replace with synchronous enrichment.

```ts
  const personIds: string[] = [];
  let pendingEmail = 0;
  const revealedEmail = 0;

  for (const pick of picks) {
    // Company (legal substrate type)
    let companyId: string | null = null;
    if (pick.company_name) {
      const companyKeys = pick.company_domain ? { domain: pick.company_domain } : { name: pick.company_name };
      const cVerdict = await ctx.substrate.propose('upsert_entity', {
        type: 'company',
        display_name: pick.company_name,
        canonical_keys: companyKeys,
        attrs: {
          name: pick.company_name,
          domain: pick.company_domain ?? null,
          source: 'lead_finder',
        },
      });
      companyId = extractEntityId(cVerdict);
    }

    // Person (legal substrate type)
    const personAttrs: Record<string, any> = {
      first_name: pick.first_name ?? null,
      last_name: pick.last_name ?? null,
      title: pick.title ?? null,
      linkedin_url: pick.linkedin_url ?? null,
      location: pick.location ?? null,
      company_id: companyId,
      company_name: pick.company_name ?? null,
      source: 'lead_finder',
    };
    if (reveal) {
      personAttrs.email = null;
      personAttrs.email_status = 'pending';
      pendingEmail += 1;
    }
    const pVerdict = await ctx.substrate.propose('upsert_entity', {
      type: 'person',
      display_name: pick.full_name,
      canonical_keys: { linkedin_url: pick.linkedin_url ?? pick.external_id },
      attrs: personAttrs,
    });
    const personId = extractEntityId(pVerdict);
    if (personId) personIds.push(personId);
  }
```

- [ ] **Step 5: Continue handler — append members to the lead_list (patch_entity with correct payload shape) and return**

```ts
  // Append selected external_ids to the lead_list's member_external_ids
  const listEntity = await ctx.substrate.getEntity(listId).catch(() => null);
  const prior: string[] = Array.isArray(listEntity?.attrs?.member_external_ids)
    ? listEntity.attrs.member_external_ids
    : [];
  const merged = Array.from(new Set([...prior, ...selected]));
  await ctx.substrate.propose('patch_entity', {
    id: listId,
    attrs_patch: {
      member_external_ids: merged,
      last_added_at: new Date().toISOString(),
      member_count: merged.length,
    },
  });

  return json(200, {
    saved_count: personIds.length,
    list_id: listId,
    person_ids: personIds,
    pending_email_count: pendingEmail,
    revealed_email_count: revealedEmail,
  });
}
```

- [ ] **Step 6: Deploy + smoke (sequenced after Task 2)**

First, run a `lead-search` and grab its `query_hash` + a few `external_id`s. Then:

```
mcp__butterbase__invoke_function  function_name=lead-save
  body: {
    "query_hash": "<from-search>",
    "result_ids": ["<id1>","<id2>"],
    "new_list_name": "Smoke test list",
    "reveal_emails": true
  }
```

Expected: `{ saved_count: 2, list_id: 'ent_...', person_ids: ['ent_...','ent_...'], pending_email_count: 2, revealed_email_count: 0 }`. Invoke a second time with the SAME body — saved_count still 2 (upsert), `lead_list.member_external_ids` length still 2 (dedupe via Set), not 4. Verify with `list-substrate-entities` that the persons exist.

- [ ] **Step 7: Edge-case smoke**

```
body: missing query_hash               → 400 query_hash_required
body: stale query_hash (random string) → 410 cache_expired
body: selected ids not in cache        → 400 selected_ids_not_in_cache
body: no list_id and no new_list_name  → 400 list_target_required
```

---

## Task 5: `saved-searches` function — CRUD for `saved_search` entities

A single endpoint with an `action` discriminator. List, create, update, delete. Returns `saved_search` entities filtered by current user's workspace.

**Files:**
- Create: `backend/functions/saved-searches/function.json`
- Create: `backend/functions/saved-searches/handler.ts`

**Interfaces:**
- Produces:
  - HTTP body: `{ action: 'list' | 'create' | 'update' | 'delete'; ... }`
  - list response: `{ entities: SavedSearchEntity[] }` where `SavedSearchEntity = { entity_id, attrs: { name, query?, filters, last_run_at?, last_result_count?, created_by, workspace_id, created_at } }`
  - create body: `{ action: 'create', name: string, query?: string, filters: SearchFilters }` → returns the created entity
  - update body: `{ action: 'update', entity_id: string, attrs: Partial<{ name, query, filters, last_run_at, last_result_count }> }`
  - delete body: `{ action: 'delete', entity_id: string }` → `{ deleted: true }`

- [ ] **Step 1: Create `function.json`** (same auth/timeout shape as Task 3).

```json
{
  "name": "saved-searches",
  "description": "CRUD over saved_search substrate entities. action: list | create | update | delete.",
  "triggers": [
    { "type": "http", "config": { "auth": "required" }, "enabled": true }
  ],
  "timeoutMs": 10000,
  "memoryLimitMb": 128,
  "agent_tool": false
}
```

- [ ] **Step 2: Write the handler — KV-backed**

Saved searches are stored in `ctx.kv` under per-user keys `savedsearch:{userId}:{slug}`. An index key `savedsearch:{userId}:_index` holds the list of slugs so `list` is O(1) without needing a `ctx.kv.list` API.

```ts
// backend/functions/saved-searches/handler.ts
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
}

const itemKey = (userId: string, slug: string) => `savedsearch:${userId}:${slug}`;
const indexKey = (userId: string) => `savedsearch:${userId}:_index`;

interface SavedSearchRecord {
  slug: string;
  name: string;
  query?: string | null;
  filters: Record<string, any>;
  last_run_at?: string;
  last_result_count?: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

async function readIndex(ctx: any, userId: string): Promise<string[]> {
  const ix = await ctx.kv.get<string[]>(indexKey(userId));
  return Array.isArray(ix) ? ix : [];
}

async function writeIndex(ctx: any, userId: string, slugs: string[]) {
  // ~10y TTL — effectively permanent without being immortal
  await ctx.kv.set(indexKey(userId), slugs, { ttl: 60 * 60 * 24 * 365 * 10 });
}

export async function handler(req: Request, ctx: any) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });
  const userId: string = String(ctx.user.id);

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const action = body?.action;

  if (action === 'list') {
    const slugs = await readIndex(ctx, userId);
    const items: SavedSearchRecord[] = [];
    for (const slug of slugs) {
      const rec = await ctx.kv.get<SavedSearchRecord>(itemKey(userId, slug));
      if (rec) items.push(rec);
    }
    return json(200, { items });
  }

  if (action === 'create') {
    const name = String(body?.name ?? '').trim();
    const filters = body?.filters ?? {};
    const query = typeof body?.query === 'string' ? body.query : null;
    if (!name) return json(400, { error: 'name_required' });

    // Generate a unique slug
    const slugs = await readIndex(ctx, userId);
    let slug = slugify(name);
    let suffix = 1;
    while (slugs.includes(slug)) { suffix += 1; slug = `${slugify(name)}-${suffix}`; }

    const now = new Date().toISOString();
    const rec: SavedSearchRecord = {
      slug, name, query, filters,
      created_by: userId,
      created_at: now,
      updated_at: now,
    };
    await ctx.kv.set(itemKey(userId, slug), rec, { ttl: 60 * 60 * 24 * 365 * 10 });
    await writeIndex(ctx, userId, [...slugs, slug]);
    return json(200, { slug, item: rec });
  }

  if (action === 'update') {
    const slug = String(body?.slug ?? '');
    if (!slug) return json(400, { error: 'slug_required' });
    const existing = await ctx.kv.get<SavedSearchRecord>(itemKey(userId, slug));
    if (!existing) return json(404, { error: 'not_found' });
    const patch = body?.attrs ?? {};
    const merged: SavedSearchRecord = {
      ...existing,
      ...patch,
      slug: existing.slug,                 // immutable
      created_by: existing.created_by,     // immutable
      created_at: existing.created_at,     // immutable
      updated_at: new Date().toISOString(),
    };
    await ctx.kv.set(itemKey(userId, slug), merged, { ttl: 60 * 60 * 24 * 365 * 10 });
    return json(200, { item: merged });
  }

  if (action === 'delete') {
    const slug = String(body?.slug ?? '');
    if (!slug) return json(400, { error: 'slug_required' });
    await ctx.kv.del(itemKey(userId, slug));
    const slugs = await readIndex(ctx, userId);
    const next = slugs.filter((s) => s !== slug);
    if (next.length !== slugs.length) await writeIndex(ctx, userId, next);
    return json(200, { deleted: true });
  }

  return json(400, { error: 'unknown_action', detail: `action must be list|create|update|delete` });
}
```

- [ ] **Step 3: Deploy + smoke**

Note: identifiers are `slug` strings, not `entity_id`. The list response is `{ items: [...] }`, not `{ entities: [...] }`.

```
mcp__butterbase__deploy_function  function_dir=backend/functions/saved-searches

invoke  body: { "action": "create", "name": "VPs at NYC fintechs", "filters": { "titles": ["VP Engineering"], "locations": ["New York"] } }
   → expect { slug: 'vps-at-nyc-fintechs', item: { ... } }

invoke  body: { "action": "list" }
   → expect { items: [{ slug: 'vps-at-nyc-fintechs', name: 'VPs at NYC fintechs', ... }] }

invoke  body: { "action": "update", "slug": "vps-at-nyc-fintechs", "attrs": { "last_run_at": "2026-06-29T...", "last_result_count": 1380 } }
   → expect { item: { ..., last_result_count: 1380, updated_at: ... } }

invoke  body: { "action": "delete", "slug": "vps-at-nyc-fintechs" }
   → expect { deleted: true }; list again to confirm gone

invoke  body: { "action": "create", "name": "VPs at NYC fintechs" }
   → re-create the same name twice in a row → second one gets slug "vps-at-nyc-fintechs-2"
```

---

## Task 6: Sidebar nav + route registration

Wire `/leads` into the app shell. Pure plumbing — no logic.

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/routes/index.tsx`
- Create: `frontend/src/pages/LeadFinder.tsx` (placeholder so the route renders)

**Interfaces:**
- Produces: `<LeadFinder />` mounted at `/leads`

- [ ] **Step 1: Create the placeholder page**

```tsx
// frontend/src/pages/LeadFinder.tsx
export default function LeadFinder() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold">Lead Finder</h1>
      <p className="text-muted-foreground">Coming online…</p>
    </div>
  );
}
```

- [ ] **Step 2: Add the sidebar item**

In `frontend/src/components/Sidebar.tsx`, modify the `items` array. Renumber so Lead Finder slots between People and Meetings:

```tsx
import { Building2, Users, Calendar, Settings, Mail, Megaphone, Search } from 'lucide-react';

const items = [
  { to: '/companies', label: 'Companies',    icon: Building2, num: '01' },
  { to: '/people',    label: 'People',       icon: Users,     num: '02' },
  { to: '/leads',     label: 'Lead Finder',  icon: Search,    num: '03' },
  { to: '/meetings',  label: 'Meetings',     icon: Calendar,  num: '04' },
  { to: '/campaigns', label: 'Campaigns',    icon: Mail,      num: '05' },
  { to: '/social',    label: 'Social',       icon: Megaphone, num: '06' },
  { to: '/settings',  label: 'Settings',     icon: Settings,  num: '07' },
];
```

- [ ] **Step 3: Register the route**

In `frontend/src/routes/index.tsx`, add the import and the `<Route>`:

```tsx
import LeadFinder from '@/pages/LeadFinder';
// ...
// Inside the AppShell block, alongside /people:
<Route path="/leads" element={<LeadFinder />} />
```

- [ ] **Step 4: Smoke**

`cd frontend && npm run dev`. Browse to the app, log in, click "Lead Finder" in the sidebar. Expected: page renders, sidebar item is highlighted, URL shows `/leads`. No console errors.

---

## Task 7: `LeadSearchBox` component

Free-text input + editable filter chips. For v1, the user types into the box → on Enter we **don't** call an LLM; instead we open a small chip-editor below where they pick titles / industries / locations / seniorities. The chips are the source of truth for the search filters. (When Butterbase AI gateway is wired in a future task, the text box's Enter triggers an LLM translate that pre-populates the chips.)

**Files:**
- Create: `frontend/src/components/LeadSearchBox.tsx`

**Interfaces:**
- Produces:
  - `LeadSearchBox` props: `{ value: SearchFilters; onChange: (next: SearchFilters) => void; onSubmit: () => void; loading?: boolean; queryText: string; onQueryTextChange: (text: string) => void }`
  - Re-exports a `SearchFilters` type (mirrors backend `lib.ts`) — frontend defines its own copy under `frontend/src/lib/leadFinder.ts` (Task 9)

- [ ] **Step 1: Stub the types module first (consumed by every UI component)**

```ts
// frontend/src/lib/leadFinder.ts
export interface SearchFilters {
  titles?: string[];
  industries?: string[];
  locations?: string[];
  seniorities?: string[];
  company_sizes?: string[];
}

export interface SearchResult {
  external_id: string;
  full_name: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  company_name?: string;
  company_domain?: string;
  linkedin_url?: string;
  location?: string;
  email_masked?: string;
  email?: string;
  email_status?: 'masked' | 'verified' | 'guessed' | 'pending' | 'unknown';
}

export interface SearchResponse {
  results: SearchResult[];
  filters: SearchFilters;
  total_count: number;
  next_cursor?: string;
  query_hash: string;
  provider: 'mock' | 'apollo';
  from_cache: boolean;
}
```

- [ ] **Step 2: Build the search-box component**

```tsx
// frontend/src/components/LeadSearchBox.tsx
import { useState } from 'react';
import { Search, X, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import type { SearchFilters } from '@/lib/leadFinder';

const CHIP_GROUPS: { key: keyof SearchFilters; label: string }[] = [
  { key: 'titles',       label: 'Title' },
  { key: 'industries',   label: 'Industry' },
  { key: 'locations',    label: 'Location' },
  { key: 'seniorities',  label: 'Seniority' },
];

interface Props {
  value: SearchFilters;
  onChange: (next: SearchFilters) => void;
  onSubmit: () => void;
  loading?: boolean;
  queryText: string;
  onQueryTextChange: (text: string) => void;
}

export function LeadSearchBox({ value, onChange, onSubmit, loading, queryText, onQueryTextChange }: Props) {
  const [addingTo, setAddingTo] = useState<keyof SearchFilters | null>(null);
  const [draft, setDraft] = useState('');

  function removeChip(key: keyof SearchFilters, idx: number) {
    const arr = (value[key] ?? []).filter((_, i) => i !== idx);
    onChange({ ...value, [key]: arr.length ? arr : undefined });
  }

  function commitChip() {
    if (!addingTo || !draft.trim()) return;
    const arr = [...(value[addingTo] ?? []), draft.trim()];
    onChange({ ...value, [addingTo]: arr });
    setDraft('');
    setAddingTo(null);
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={queryText}
            onChange={(e) => onQueryTextChange(e.target.value)}
            placeholder="Describe who you're looking for…  e.g. VPs of engineering at NYC fintechs"
            className="pl-9"
            onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
          />
        </div>
        <Button onClick={onSubmit} disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        {CHIP_GROUPS.flatMap((group) =>
          (value[group.key] ?? []).map((v, i) => (
            <Badge key={`${group.key}-${i}`} variant="secondary" className="gap-1">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wide">{group.label}</span>
              <span>{v}</span>
              <button onClick={() => removeChip(group.key, i)} className="ml-1 hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )),
        )}

        {addingTo ? (
          <div className="flex items-center gap-1">
            <select
              value={addingTo}
              onChange={(e) => setAddingTo(e.target.value as keyof SearchFilters)}
              className="text-xs bg-transparent border rounded px-1 py-0.5"
            >
              {CHIP_GROUPS.map((g) => (
                <option key={g.key} value={g.key}>{g.label}</option>
              ))}
            </select>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitChip(); if (e.key === 'Escape') setAddingTo(null); }}
              placeholder="value"
              className="h-7 w-40 text-xs"
              autoFocus
            />
            <Button size="sm" variant="ghost" onClick={commitChip}>Add</Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setAddingTo('titles')} className="h-7 gap-1">
            <Plus className="h-3 w-3" /> Add filter
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Smoke**

This component is consumed in Task 9. Skip standalone smoke; verified via the page test there.

---

## Task 8: `LeadResultsTable` component

Selectable table with masked emails and a per-row "reveal" affordance (UI-only for v1 — the actual reveal happens via the dialog in Task 10).

**Files:**
- Create: `frontend/src/components/LeadResultsTable.tsx`

**Interfaces:**
- Produces:
  - `LeadResultsTable` props: `{ results: SearchResult[]; selected: Set<string>; onToggleSelected: (id: string) => void; onToggleAll: (checked: boolean) => void }`

- [ ] **Step 1: Build the component**

```tsx
// frontend/src/components/LeadResultsTable.tsx
import { useEffect, useRef } from 'react';
import { ExternalLink } from 'lucide-react';
import type { SearchResult } from '@/lib/leadFinder';

interface Props {
  results: SearchResult[];
  selected: Set<string>;
  onToggleSelected: (id: string) => void;
  onToggleAll: (checked: boolean) => void;
}

const CHECKBOX_CLASS = 'h-4 w-4 rounded border-input text-foreground focus:ring-2 focus:ring-ring focus:ring-offset-0 accent-foreground cursor-pointer';

export function LeadResultsTable({ results, selected, onToggleSelected, onToggleAll }: Props) {
  const allSelected = results.length > 0 && results.every((r) => selected.has(r.external_id));
  const someSelected = !allSelected && results.some((r) => selected.has(r.external_id));
  const headerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = someSelected;
  }, [someSelected]);

  return (
    <div className="rounded-md border">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/30 text-left">
          <tr>
            <th className="px-3 py-2 w-10">
              <input
                ref={headerRef}
                type="checkbox"
                checked={allSelected}
                onChange={(e) => onToggleAll(e.target.checked)}
                aria-label="Select all"
                className={CHECKBOX_CLASS}
              />
            </th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Title</th>
            <th className="px-3 py-2">Company</th>
            <th className="px-3 py-2">Email (masked)</th>
            <th className="px-3 py-2 w-12">LinkedIn</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.external_id} className="border-b last:border-0 hover:bg-muted/20">
              <td className="px-3 py-2">
                <input
                  type="checkbox"
                  checked={selected.has(r.external_id)}
                  onChange={() => onToggleSelected(r.external_id)}
                  aria-label={`Select ${r.full_name}`}
                  className={CHECKBOX_CLASS}
                />
              </td>
              <td className="px-3 py-2 font-medium">{r.full_name}</td>
              <td className="px-3 py-2 text-muted-foreground">{r.title ?? '—'}</td>
              <td className="px-3 py-2 text-muted-foreground">{r.company_name ?? '—'}</td>
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                {r.email_masked ?? '—'}
              </td>
              <td className="px-3 py-2">
                {r.linkedin_url ? (
                  <a href={r.linkedin_url} target="_blank" rel="noreferrer" className="inline-flex items-center text-muted-foreground hover:text-foreground">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : '—'}
              </td>
            </tr>
          ))}
          {results.length === 0 && (
            <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground text-sm">No results yet — run a search.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Smoke** — verified in Task 9 via the page.

---

## Task 9: `LeadFinder` page — wire search + table

Replace the placeholder from Task 6 with the real page: search box, results table, basic pagination, and a "Selected: N" footer that opens the Add-to-list dialog (built in Task 10).

**Files:**
- Modify: `frontend/src/pages/LeadFinder.tsx`

**Interfaces:**
- Consumes: `LeadSearchBox` (Task 7), `LeadResultsTable` (Task 8), `bb.functions.invoke`, `SearchFilters`/`SearchResult`/`SearchResponse` from Task 7

- [ ] **Step 1: Replace the placeholder with full page logic**

```tsx
// frontend/src/pages/LeadFinder.tsx
import { useCallback, useState } from 'react';
import { bb } from '@/lib/butterbase';
import { Button } from '@/components/ui/button';
import { LeadSearchBox } from '@/components/LeadSearchBox';
import { LeadResultsTable } from '@/components/LeadResultsTable';
import type { SearchFilters, SearchResponse } from '@/lib/leadFinder';

export default function LeadFinder() {
  const [filters, setFilters] = useState<SearchFilters>({});
  const [queryText, setQueryText] = useState('');
  const [resp, setResp] = useState<SearchResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: invokeErr } = await bb.functions.invoke('lead-search', {
        body: { query: queryText, filters, page_size: 25 },
      });
      if (invokeErr) throw invokeErr;
      const d = data as SearchResponse;
      setResp(d);
      setSelected(new Set());
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setResp(null);
    } finally {
      setLoading(false);
    }
  }, [filters, queryText]);

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback((checked: boolean) => {
    if (!resp) return;
    setSelected(checked ? new Set(resp.results.map((r) => r.external_id)) : new Set());
  }, [resp]);

  return (
    <div className="p-6 space-y-4 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Lead Finder</h1>
        <p className="text-sm text-muted-foreground">
          Search for people by role, industry, and location. Add to a list to reveal emails.
        </p>
      </div>

      <LeadSearchBox
        value={filters}
        onChange={setFilters}
        onSubmit={runSearch}
        loading={loading}
        queryText={queryText}
        onQueryTextChange={setQueryText}
      />

      {error && (
        <div className="text-sm text-destructive border border-destructive/30 rounded px-3 py-2">
          {error}
        </div>
      )}

      {resp && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <div>
            {resp.total_count.toLocaleString()} matches · showing {resp.results.length}
            {resp.from_cache && <span className="ml-2 px-1.5 py-0.5 rounded bg-muted text-[10px] uppercase tracking-wide">cached</span>}
          </div>
        </div>
      )}

      <LeadResultsTable
        results={resp?.results ?? []}
        selected={selected}
        onToggleSelected={toggleSelected}
        onToggleAll={toggleAll}
      />

      {selected.size > 0 && (
        <div className="sticky bottom-4 flex items-center justify-between rounded-md border bg-background p-3 shadow-sm">
          <div className="text-sm">{selected.size} selected</div>
          <Button disabled>Add to list… (next task)</Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Smoke**

`npm run dev`. On `/leads`:
1. Page renders, "No results yet" placeholder shows.
2. Click "+ Add filter" → switch to Title → type "VP Engineering" → Add. Chip appears.
3. Add a Location chip "New York".
4. Click Search. Spinner → results appear, total count shown, masked emails visible.
5. Search again immediately → "cached" badge appears, results identical.
6. Click a row checkbox → "1 selected" footer appears; "Select all" header checkbox checks every row.

---

## Task 10: `AddToListDialog` + wire to page

Cost-preview dialog. On open, calls `lead-cost-preview` for the selected count. Two actions: "Add without emails" (zero credit cost) and "Confirm & reveal" (burns credits). Both call `lead-save` with the appropriate `reveal_emails` flag.

The list-target picker is intentionally minimal for v1: a freeform text input ("New list name…") + a future-extension placeholder for "existing list" once Saved Lists view exists.

**Files:**
- Create: `frontend/src/components/AddToListDialog.tsx`
- Modify: `frontend/src/pages/LeadFinder.tsx`

**Interfaces:**
- Produces:
  - `AddToListDialog` props: `{ open: boolean; onClose: () => void; queryHash: string; selectedIds: string[]; onSaved: (info: { saved_count: number; list_id: string }) => void }`

- [ ] **Step 1: Build the dialog**

```tsx
// frontend/src/components/AddToListDialog.tsx
import { useEffect, useState } from 'react';
import { bb } from '@/lib/butterbase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

interface CostPreview {
  credits: number;
  usd_estimate: number;
  reveal_emails: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  queryHash: string;
  selectedIds: string[];
  onSaved: (info: { saved_count: number; list_id: string }) => void;
}

export function AddToListDialog({ open, onClose, queryHash, selectedIds, onSaved }: Props) {
  const [listName, setListName] = useState('');
  const [revealCost, setRevealCost] = useState<CostPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setRevealCost(null);
    setLoading(true);
    bb.functions
      .invoke('lead-cost-preview', { body: { result_ids: selectedIds, reveal_emails: true } })
      .then(({ data, error: e }) => {
        if (e) throw e;
        setRevealCost(data as CostPreview);
      })
      .catch((e: any) => setError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [open, selectedIds]);

  async function save(reveal: boolean) {
    if (!listName.trim()) { setError('Please enter a list name.'); return; }
    setSaving(true);
    setError(null);
    try {
      const { data, error: e } = await bb.functions.invoke('lead-save', {
        body: {
          query_hash: queryHash,
          result_ids: selectedIds,
          new_list_name: listName.trim(),
          reveal_emails: reveal,
        },
      });
      if (e) throw e;
      const d = data as { saved_count: number; list_id: string };
      onSaved(d);
      onClose();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add {selectedIds.length} {selectedIds.length === 1 ? 'lead' : 'leads'} to a list</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <label className="text-sm font-medium">List name</label>
            <Input
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              placeholder="e.g. Q3 fintech VPs"
              disabled={saving}
            />
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            {loading && <div className="text-muted-foreground">Calculating cost…</div>}
            {revealCost && (
              <>
                <div>
                  Revealing emails will use <span className="font-medium">{revealCost.credits} credits</span>
                  {' '}(≈ <span className="font-medium">${revealCost.usd_estimate.toFixed(2)}</span>)
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Or add without revealing — leads are saved with empty email; you can reveal later.
                </div>
              </>
            )}
          </div>

          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="secondary" onClick={() => save(false)} disabled={saving || !listName.trim()}>
            Add without emails
          </Button>
          <Button onClick={() => save(true)} disabled={saving || !listName.trim() || !revealCost}>
            Confirm &amp; reveal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Wire the dialog into `LeadFinder.tsx`**

Replace the disabled "Add to list…" button block at the bottom of the page:

```tsx
import { AddToListDialog } from '@/components/AddToListDialog';

// inside the component, near other useState:
const [dialogOpen, setDialogOpen] = useState(false);
const [savedToast, setSavedToast] = useState<string | null>(null);

// replace the previous "Add to list… (next task)" Button with:
{selected.size > 0 && (
  <div className="sticky bottom-4 flex items-center justify-between rounded-md border bg-background p-3 shadow-sm">
    <div className="text-sm">{selected.size} selected</div>
    <Button onClick={() => setDialogOpen(true)}>Add to list…</Button>
  </div>
)}

{resp && (
  <AddToListDialog
    open={dialogOpen}
    onClose={() => setDialogOpen(false)}
    queryHash={resp.query_hash}
    selectedIds={[...selected]}
    onSaved={(info) => {
      setSavedToast(`Saved ${info.saved_count} leads to list ${info.list_id}`);
      setSelected(new Set());
      setTimeout(() => setSavedToast(null), 4000);
    }}
  />
)}

{savedToast && (
  <div className="fixed bottom-6 right-6 rounded-md border bg-background p-3 shadow text-sm">
    {savedToast}
  </div>
)}
```

- [ ] **Step 3: Smoke**

`npm run dev`. On `/leads`:
1. Run a search, select 3 results.
2. Click "Add to list…" → dialog opens, "Calculating cost…" briefly, then "Revealing emails will use 3 credits (≈ $0.15)" (since EMAIL_CREDIT=1, USD_PER_CREDIT=0.05).
3. Type "Smoke test" as list name → "Confirm & reveal" enables.
4. Click "Add without emails" → dialog closes, toast shows "Saved 3 leads to list ent_…".
5. Navigate to `/people` → the three saved people appear in the People list.
6. Re-run search, select same 3 → "Add without emails" again → People list still shows them (upsert, no duplicates).

---

## Task 11: `SavedSearchesPanel` + wire to page

A small panel rendered to the right of the results table, showing saved searches. Click one → it loads its filters into the search box and immediately runs. Save the current search → opens a name prompt and calls `saved-searches` create.

**Files:**
- Create: `frontend/src/components/SavedSearchesPanel.tsx`
- Modify: `frontend/src/pages/LeadFinder.tsx`

**Interfaces:**
- Produces:
  - `SavedSearchesPanel` props: `{ onLoad: (filters: SearchFilters, query?: string) => void; signalRefresh: number }`
  - Exposes a "Save current search" button at the top, which the page uses to push the current filters into the panel.

- [ ] **Step 1: Build the panel**

```tsx
// frontend/src/components/SavedSearchesPanel.tsx
import { useCallback, useEffect, useState } from 'react';
import { Star, Trash2 } from 'lucide-react';
import { bb } from '@/lib/butterbase';
import { Button } from '@/components/ui/button';
import type { SearchFilters } from '@/lib/leadFinder';

interface SavedSearchItem {
  slug: string;
  name: string;
  query?: string | null;
  filters: SearchFilters;
  last_run_at?: string;
  last_result_count?: number;
}

interface Props {
  onLoad: (filters: SearchFilters, query?: string) => void;
  signalRefresh: number;
}

export function SavedSearchesPanel({ onLoad, signalRefresh }: Props) {
  const [items, setItems] = useState<SavedSearchItem[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await bb.functions.invoke('saved-searches', { body: { action: 'list' } });
      if (error) throw error;
      setItems(((data as any)?.items ?? []) as SavedSearchItem[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, signalRefresh]);

  async function del(slug: string) {
    await bb.functions.invoke('saved-searches', { body: { action: 'delete', slug } });
    load();
  }

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-2 mb-3">
        <Star className="h-4 w-4 text-butter" />
        <h2 className="text-sm font-medium">Saved searches</h2>
      </div>
      {loading && <div className="text-xs text-muted-foreground">Loading…</div>}
      {!loading && items.length === 0 && (
        <div className="text-xs text-muted-foreground">None yet.</div>
      )}
      <ul className="space-y-1">
        {items.map((s) => (
          <li key={s.slug} className="flex items-center gap-2 group">
            <button
              onClick={() => onLoad(s.filters, s.query ?? undefined)}
              className="flex-1 text-left text-sm hover:text-butter truncate"
              title={JSON.stringify(s.filters)}
            >
              {s.name}
            </button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 opacity-0 group-hover:opacity-100"
              onClick={() => del(s.slug)}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Wire the panel + "Save search" action into `LeadFinder.tsx`**

```tsx
import { SavedSearchesPanel } from '@/components/SavedSearchesPanel';

// inside the component:
const [savedRefresh, setSavedRefresh] = useState(0);

async function saveCurrentSearch() {
  const name = window.prompt('Name this search:', queryText || 'Untitled search');
  if (!name) return;
  await bb.functions.invoke('saved-searches', {
    body: { action: 'create', name, query: queryText, filters },
  });
  setSavedRefresh((n) => n + 1);
}

// Re-layout the body so the panel sits to the right of the main column:
return (
  <div className="p-6 max-w-6xl">
    <div className="flex items-baseline justify-between mb-4">
      <div>
        <h1 className="text-2xl font-semibold">Lead Finder</h1>
        <p className="text-sm text-muted-foreground">
          Search for people by role, industry, and location. Add to a list to reveal emails.
        </p>
      </div>
      {resp && (
        <Button variant="ghost" size="sm" onClick={saveCurrentSearch}>
          Save search
        </Button>
      )}
    </div>

    <div className="grid grid-cols-[1fr_240px] gap-6">
      <div className="space-y-4">
        {/* ... LeadSearchBox, error, count, LeadResultsTable, selected-footer, dialog, toast — same as Task 10 ... */}
      </div>
      <div className="space-y-3">
        <SavedSearchesPanel
          onLoad={(f, q) => {
            setFilters(f);
            setQueryText(q ?? '');
            // run immediately
            setTimeout(() => runSearch(), 0);
          }}
          signalRefresh={savedRefresh}
        />
      </div>
    </div>
  </div>
);
```

- [ ] **Step 3: Smoke**

`npm run dev`. On `/leads`:
1. Run a search.
2. "Save search" button appears top-right → click → prompt → name it "VP Eng NYC" → panel updates to show it.
3. Clear filters with the X chips. Click "VP Eng NYC" in the panel → filters re-populate, search runs automatically, results identical to before.
4. Hover a saved item → trash icon appears → click → item gone, list refreshes.

---

## Task 12: End-to-end smoke + sweep

A single end-to-end run through the whole feature, plus a quick code sweep for placeholders / TODOs introduced.

- [ ] **Step 1: Full E2E walkthrough**

`npm run dev`, sign in, navigate to `/leads`:

1. Add Title chip "VP Engineering", Location chip "New York", Industry chip "Financial Services".
2. Search → 25 results with masked emails. Note `query_hash` from devtools network panel.
3. Save the search as "NYC fintech VPs".
4. Select 5 rows → "Add to list…" → dialog shows "Revealing emails will use 5 credits (≈ $0.25)".
5. List name "Test Run". Click "Confirm & reveal".
6. Toast: "Saved 5 leads to list ent_…". Navigate to `/people` → 5 new people visible. Each should have `email_status: 'pending'` (visible in their detail page if `email_status` is rendered; otherwise check via `invoke_function list-substrate-entities type=person`).
7. Back to `/leads`. Click the saved search → instantly reruns. Add 3 different rows. "Add without emails" → 3 more people, all with no email status / null.
8. Re-run the same selection → still upserts to same person records, lead_list member_count grows by 0 (deduped via Set).

- [ ] **Step 2: Sweep for placeholders**

Grep across the new files:

```bash
grep -nE "TODO|FIXME|XXX|placeholder" backend/functions/lead-search backend/functions/lead-cost-preview backend/functions/lead-save backend/functions/saved-searches frontend/src/pages/LeadFinder.tsx frontend/src/components/{LeadSearchBox,LeadResultsTable,AddToListDialog,SavedSearchesPanel}.tsx frontend/src/lib/leadFinder.ts
```

Expected: zero matches except the one intentional comment in `lead-search/handler.ts` marking the provider-swap point (`=== PROVIDER BRANCH ===`). If anything else surfaces, address inline.

- [ ] **Step 3: Document the provider-swap point**

Append a one-line note to the design doc so the next person knows where to plug Apollo in:

```markdown
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
```

Append the above to `docs/superpowers/specs/2026-06-29-lead-finder-design.md`.

- [ ] **Step 4: Wrap**

Sanity-list of what's deployed for handoff:

```
mcp__butterbase__manage_function action=list app_id=app_44zjayftl7b3
```

Expected to include: `lead-search`, `lead-cost-preview`, `lead-save`, `saved-searches`. No git steps — this codebase isn't a git repo.

---

## Self-review

**Spec coverage check** (against `docs/superpowers/specs/2026-06-29-lead-finder-design.md`):

| Spec section | Tasks covering it |
|---|---|
| Substrate entities `SavedSearch`, `LeadSearchCache` | Tasks 2 (cache), 5 (saved_search). `LeadSearchCache` is created implicitly by `lead-search` writes, not via migration — substrate is schemaless. |
| `LeadSearchProvider` interface | Dropped — design was updated post-Butterbase-handoff to call managed Apollo directly. Task 2 contains a clearly-marked provider branch instead. |
| LLM translator | Stubbed: filters arrive structured from the frontend chips. Provider-branch comment in Task 2 documents the swap point. |
| Masked email teaser | Task 1 (`maskEmail`), Task 8 (table column). |
| Cost-preview dialog | Tasks 3 + 10. |
| Save-to-list flow | Task 4 + 10. |
| Lead lists | Created on first save in Task 4 (`lead_list` substrate type). No standalone list-view page — that's a future task; for v1 lists exist as substrate entities only. |
| Saved searches | Tasks 5 + 11. |
| Frontend `/leads` route + sidebar | Task 6. |
| Frontend components | Tasks 7, 8, 9, 10, 11. |
| v2 swap-in doc | Task 12 step 3. |

**Placeholder scan:** None — every step contains exact code or exact commands. The one intentional `=== PROVIDER BRANCH ===` marker is documented as a swap-point, not a placeholder.

**Type consistency:** `SearchFilters` and `SearchResult` defined in two places (backend `lib.ts` Task 1, frontend `leadFinder.ts` Task 7) — intentional, since backend/frontend don't share a TS source. Both copies must be kept in sync at swap-in time; noted explicitly.

**Out-of-scope** (deferred to post-Apollo-managed):
- LLM free-text → filter translation
- Real Apollo HTTP calls
- Real cost numbers from Butterbase pricing config
- "Existing list" picker in AddToListDialog (only "new list name" today)
- Standalone `/lead-lists` view
- Saved-search diff ("3 new matches since last run")
- Per-row email reveal (today the only reveal path is the dialog)
