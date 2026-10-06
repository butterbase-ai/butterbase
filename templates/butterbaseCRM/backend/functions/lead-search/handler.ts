// Lead Finder search orchestration.
// lib.ts is inlined here because Butterbase functions don't support relative imports.
// If you edit either the helpers or the handler, keep them in this one file.

interface SearchFilters {
  titles?: string[];
  industries?: string[];
  locations?: string[];
  seniorities?: string[];
  company_sizes?: string[];
}

interface SearchResult {
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

async function hashFilters(f: SearchFilters): Promise<string> {
  const data = new TextEncoder().encode(canonical(f));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function maskEmail(
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

function mockSearch(
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
    const linkedinSlug = `${first}-${last}-${(seed % 9999).toString().padStart(4, '0')}`.toLowerCase();
    results.push({
      external_id: `https://www.linkedin.com/in/${linkedinSlug}`,
      full_name: `${first} ${last}`,
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

// ---- handler ----

const CACHE_TTL_SEC = 24 * 60 * 60;
const cacheKey = (h: string) => `leadcache:${h}`;

interface CacheBlob {
  query_hash: string;
  filters: SearchFilters;
  results: SearchResult[];
  next_cursor?: string;
  total_count: number;
  provider: 'mock' | 'apollo' | 'people_api';
  cached_at: string;
}

// Hard caps when calling the People API.
// Butterbase People API caps pageSize at 100 per request (silently clamps above).
const HARD_MAX_PAGE_SIZE = 100;

function joinOr(values: string[] | undefined): string | undefined {
  if (!values || values.length === 0) return undefined;
  if (values.length === 1) return values[0];
  return `(${values.map((v) => v.includes(' ') ? `"${v}"` : v).join(' OR ')})`;
}

function splitLocation(loc: string): { city?: string; region?: string; country?: string } {
  const parts = loc.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) return { city: parts[0], region: parts[1], country: parts[2] };
  if (parts.length === 2) return { city: parts[0], country: parts[1] };
  return { city: parts[0] };
}

function mapFiltersToPeopleApi(filters: SearchFilters): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Titles + seniorities fold into currentRoleTitle (boolean syntax).
  const titleTerms = [...(filters.titles ?? [])];
  // Add seniority hints — Apollo's title search is good enough to match them as substrings.
  for (const s of filters.seniorities ?? []) {
    if (s === 'c_suite') titleTerms.push('CEO', 'CTO', 'CFO', 'COO');
    else if (s === 'vp') titleTerms.push('VP', 'Vice President');
    else if (s === 'director') titleTerms.push('Director');
    else if (s === 'founder') titleTerms.push('Founder');
  }
  const titleQuery = joinOr(titleTerms);
  if (titleQuery) out.currentRoleTitle = titleQuery;

  const industryQuery = joinOr(filters.industries);
  if (industryQuery) out.currentCompanyIndustry = industryQuery;

  // Locations: use the first one, split into city/region/country.
  if (filters.locations && filters.locations.length > 0) {
    const { city, region, country } = splitLocation(filters.locations[0]);
    if (city) out.city = city;
    if (region) out.region = region;
    if (country) out.country = country;
  }

  return out;
}

interface PeopleApiPersonResult {
  linkedinProfileUrl?: string;
  profile?: {
    firstName?: string;
    lastName?: string;
    fullName?: string;
    headline?: string;
    occupation?: string;
    city?: string;
    state?: string;
    country?: string;
    experiences?: Array<{ company?: string; title?: string }>;
  } | null;
}

function mapPersonResultToSearchResult(p: PeopleApiPersonResult): SearchResult | null {
  const linkedin = p.linkedinProfileUrl?.trim();
  if (!linkedin) return null;
  // Per People API handoff doc: a minority of results return an internal reference
  // URL instead of linkedin.com/in/...; those can't be enriched or email-looked-up
  // by downstream calls, so drop them at this layer.
  if (!/^https?:\/\/([a-z0-9-]+\.)?linkedin\.com\/in\//i.test(linkedin)) return null;
  const profile = p.profile ?? {};
  const fullName = profile.fullName?.trim() || [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();
  if (!fullName) return null;
  const topExp = (profile.experiences ?? [])[0] ?? {};
  const companyName = topExp.company?.trim() || undefined;
  const title = topExp.title?.trim() || profile.headline?.trim() || profile.occupation?.trim();
  const location = [profile.city, profile.state, profile.country].filter(Boolean).join(', ') || undefined;
  return {
    external_id: linkedin,
    full_name: fullName,
    first_name: profile.firstName,
    last_name: profile.lastName,
    title,
    company_name: companyName,
    company_domain: undefined, // not returned by People API search
    linkedin_url: linkedin,
    location,
    email_masked: maskEmail(profile.firstName, undefined, companyName),
    email_status: 'masked',
  };
}

async function peopleApiSearch(
  input: { query?: string; filters?: SearchFilters },
  pageSize: number,
  ctx: any,
): Promise<{ results: SearchResult[]; total_count: number; usage?: { credits: number; usd: number } } | { error: string; status?: number }> {
  // Per handoff doc: when `query` is present the API ignores structured filters
  // and uses NL ranking on every backend. Prefer NL — better quality, no Haiku tax.
  const body: Record<string, unknown> = input.query
    ? { query: input.query, enrichProfiles: true, pageSize: Math.min(pageSize, HARD_MAX_PAGE_SIZE) }
    : { ...mapFiltersToPeopleApi(input.filters ?? {}), enrichProfiles: true, pageSize: Math.min(pageSize, HARD_MAX_PAGE_SIZE) };

  try {
    const res = await fetch(
      `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/people/search/person`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const detail = await res.text();
      return { error: `people_api_${res.status}: ${detail.slice(0, 200)}`, status: res.status };
    }
    const json: any = await res.json();
    const data = json?.data ?? {};
    const usage = json?.usage ?? {};
    // Per handoff doc: headers are the authoritative cost source; body usage is a
    // convenience copy. Prefer body when present, fall back to headers.
    const hdrCredits = Number(res.headers.get('x-people-credits-consumed') ?? NaN);
    const hdrUsd = Number(res.headers.get('x-people-usd-charged') ?? NaN);
    const credits = Number.isFinite(Number(usage.creditsConsumed)) ? Number(usage.creditsConsumed) : (Number.isFinite(hdrCredits) ? hdrCredits : 0);
    const usd = Number.isFinite(Number(usage.usdCharged)) ? Number(usage.usdCharged) : (Number.isFinite(hdrUsd) ? hdrUsd : 0);
    const provider = res.headers.get('x-people-provider') ?? undefined;
    const raw: PeopleApiPersonResult[] = Array.isArray(data.results) ? data.results : [];
    const results = raw.map(mapPersonResultToSearchResult).filter((r): r is SearchResult => r !== null);
    const dropped = raw.length - results.length;
    console.log(JSON.stringify({ evt: 'lead_search_usage', credits, usd, provider, results: results.length, dropped, pageSize: body.pageSize }));
    // Report post-filter count to the UI — the raw People API count includes
    // non-linkedin URLs we just dropped (can't enrich/email-lookup), so showing
    // the raw count produces a confusing "66 of 68" mismatch.
    return {
      results,
      total_count: results.length,
      usage: { credits, usd },
    };
  } catch (e: any) {
    return { error: `people_api_throw: ${String(e?.message ?? e).slice(0, 200)}` };
  }
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

async function hashString(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handler(req: Request, ctx: any) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const filters = sanitizeFilters(body?.filters);
  const query: string = typeof body?.query === 'string' ? body.query.trim() : '';

  const hasAnyFilter = !!(filters.titles?.length || filters.industries?.length || filters.locations?.length || filters.seniorities?.length);
  // NL takes precedence: if the user typed a free-text query, send it straight to the
  // People API and skip the (lossy) Haiku translation. Structured filters are only used
  // when no NL query was provided.
  const useNL = query.length > 0;

  if (!useNL && !hasAnyFilter) {
    return json(400, { error: 'query_or_filters_required' });
  }

  // HARD CAP: never more than 100 in a single page, regardless of caller.
  const pageSize = Math.min(Math.max(Number(body?.page_size) || 25, 1), HARD_MAX_PAGE_SIZE);
  // Pagination disabled in this build — we always return one page only.
  void body?.cursor;

  // Cache by NL query string (lowercased + trimmed) OR by canonical filter hash.
  const queryHash = useNL
    ? `nl:${await hashString(query.toLowerCase())}`
    : await hashFilters(filters);

  try {
    const hit = await ctx.kv.get<CacheBlob>(cacheKey(queryHash));
    if (hit && hit.query_hash === queryHash) {
      return json(200, {
        results: hit.results.slice(0, pageSize),
        filters: hit.filters,
        query: useNL ? query : undefined,
        total_count: hit.results.length,
        next_cursor: undefined,
        query_hash: queryHash,
        provider: hit.provider,
        from_cache: true,
      });
    }
  } catch { /* cache miss is non-fatal */ }

  // === PROVIDER BRANCH — Butterbase People API ===
  const apiResult = await peopleApiSearch(useNL ? { query } : { filters }, pageSize, ctx);
  if ('error' in apiResult) {
    if (apiResult.status === 402) {
      return json(402, { error: 'insufficient_credits', detail: apiResult.error });
    }
    return json(502, { error: 'provider_failed', detail: apiResult.error });
  }
  const { results, total_count } = apiResult;
  const provider: 'people_api' = 'people_api';
  // === END PROVIDER BRANCH ===

  const blob: CacheBlob = {
    query_hash: queryHash,
    filters,
    results,
    next_cursor: undefined,
    total_count,
    provider,
    cached_at: new Date().toISOString(),
  };
  try { await ctx.kv.set(cacheKey(queryHash), blob, { ttl: CACHE_TTL_SEC }); } catch { /* non-fatal */ }

  return json(200, {
    results,
    filters: useNL ? {} : filters,
    query: useNL ? query : undefined,
    total_count,
    next_cursor: undefined,
    query_hash: queryHash,
    provider,
    from_cache: false,
    usage: apiResult.usage,
  });
}

