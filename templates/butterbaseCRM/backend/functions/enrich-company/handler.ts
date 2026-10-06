// Enrich a company entity using the Butterbase People API.
//
// The People API's search_company endpoint only supports (industry, country,
// employee_count_max) filters — no domain or name filter — so it's a poor fit
// for enriching a specific known company. Instead we lean on person profiles:
//
//   1. Find people at this company that have a linkedin_url.
//   2. get_profile on the first hit. Their `experiences` array has the current
//      role, which carries a `company` name/logo/description AND we can walk
//      the `experiences` list to pick the entry whose `company` matches this
//      company (best-effort).
//   3. Patch company attrs: industry (only if the profile exposes it directly),
//      logo (from experience.logo_url), description, location.
//
// This is intentionally a light pass — the primitive doesn't include
// firmographics for companies, so we backfill what's cheap and reliable.
// Anything richer (industry, employee_count) still routes through the copilot.

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function normStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

async function peopleGetProfile(ctx: any, linkedinUrl: string) {
  const res = await fetch(
    `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/people/profile`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
      body: JSON.stringify({ linkedinProfileUrl: linkedinUrl }),
    },
  );
  const hdrCredits = Number(res.headers.get('x-people-credits-consumed') ?? NaN);
  const hdrUsd = Number(res.headers.get('x-people-usd-charged') ?? NaN);
  if (!res.ok) {
    const detail = await res.text();
    return { error: `people_profile_${res.status}: ${detail.slice(0, 200)}` };
  }
  const j: any = await res.json();
  const usage = j?.usage ?? {};
  const credits = Number.isFinite(Number(usage.creditsConsumed)) ? Number(usage.creditsConsumed) : (Number.isFinite(hdrCredits) ? hdrCredits : 0);
  const usd = Number.isFinite(Number(usage.usdCharged)) ? Number(usage.usdCharged) : (Number.isFinite(hdrUsd) ? hdrUsd : 0);
  return { data: j?.data ?? null, credits, usd };
}

function pickCompanyExperience(profile: any, companyName: string | null, companyDomain: string | null): any | null {
  const exps = Array.isArray(profile?.experiences) ? profile.experiences : [];
  if (exps.length === 0) return null;
  const nameLC = companyName?.toLowerCase() ?? '';
  const domainSlug = companyDomain?.toLowerCase().replace(/^www\./, '').split('.')[0] ?? '';
  // Prefer an experience whose company name matches, otherwise the current role.
  const scored = exps
    .map((e: any, i: number) => {
      const en = (e?.company ?? '').toLowerCase();
      let s = 0;
      if (nameLC && en === nameLC) s += 3;
      else if (nameLC && en.includes(nameLC)) s += 2;
      if (domainSlug && en.includes(domainSlug)) s += 1;
      if (e?.ends_at == null) s += 1; // current role tiebreaker
      return { e, i, s };
    })
    .sort((a, b) => b.s - a.s || a.i - b.i);
  return scored[0]?.s ? scored[0].e : exps[0];
}

function buildCompanyPatch(profile: any, exp: any): Record<string, any> {
  const patch: Record<string, any> = {};
  const desc = normStr(exp?.description);
  if (desc) patch.description = desc;
  const loc = normStr(exp?.location);
  if (loc) patch.location = loc;
  const linkedin = normStr(exp?.company_linkedin_profile_url);
  if (linkedin) patch.linkedin_url = linkedin;
  // Industry only if the profile-level industry field is set (rare, but populated on
  // some enrichlayer responses).
  const industry = normStr(profile?.industry);
  if (industry) patch.industry = industry;
  return patch;
}

export async function handler(req: any, ctx: any) {
  if (!ctx.substrate) return json(503, { error: 'substrate_not_linked' });
  let body: any = {};
  try { body = await req.json(); } catch { /* ok */ }
  const company_id: string | undefined = body?.company_id;
  if (!company_id) return json(400, { error: 'missing_company_id' });

  const company = await ctx.substrate.getEntity(company_id).catch(() => null);
  if (!company) return json(404, { error: 'company_not_found' });
  const companyAttrs = (company.attrs ?? {}) as Record<string, any>;
  const companyName = normStr(companyAttrs.name) ?? normStr(company.display_name);
  const companyDomain = normStr(companyAttrs.domain);
  const enrichedAtISO = new Date().toISOString();

  // Find a linked person with a linkedin_url — that's our enrichment substrate.
  const persons = await ctx.substrate.findEntities({ type: 'person', limit: 500 }).catch(() => []);
  const linked = (Array.isArray(persons) ? persons : []).filter(
    (p: any) => p?.attrs?.company_id === company_id && normStr(p?.attrs?.linkedin_url),
  );

  if (linked.length === 0) {
    await ctx.substrate.propose('patch_entity', {
      id: company_id,
      attrs_patch: { enrichment_status: 'no_signal', enriched_at: enrichedAtISO },
    });
    return json(200, {
      ok: true,
      status: 'no_signal',
      reason: 'No people at this company with a linkedin_url. Add a person first, then re-enrich.',
    });
  }

  let credits = 0;
  let usd = 0;
  let patch: Record<string, any> | null = null;
  let usedPersonId: string | null = null;

  // Try up to 3 people before giving up — cached profiles cost 0, so this is cheap
  // when the workspace already has enriched contacts.
  for (const p of linked.slice(0, 3)) {
    const url = normStr(p.attrs.linkedin_url);
    if (!url) continue;
    const r = await peopleGetProfile(ctx, url);
    if ('error' in r) continue;
    credits += r.credits;
    usd += r.usd;
    const exp = pickCompanyExperience(r.data, companyName, companyDomain);
    if (!exp) continue;
    patch = buildCompanyPatch(r.data, exp);
    if (Object.keys(patch).length > 0) {
      usedPersonId = p.entity_id ?? p.id;
      break;
    }
  }

  if (!patch || Object.keys(patch).length === 0) {
    await ctx.substrate.propose('patch_entity', {
      id: company_id,
      attrs_patch: { enrichment_status: 'no_match', enriched_at: enrichedAtISO },
    });
    return json(200, { ok: true, status: 'no_match', usage: { credits, usd } });
  }

  patch.enrichment_status = 'people_api_ok';
  patch.enriched_at = enrichedAtISO;

  await ctx.substrate.propose('patch_entity', {
    id: company_id,
    attrs_patch: patch,
  });

  console.log(JSON.stringify({ evt: 'enrich_company_usage', company_id, credits, usd, via_person: usedPersonId, fields: Object.keys(patch).length - 2 }));
  return json(200, {
    ok: true,
    status: 'people_api_ok',
    patched_fields: Object.keys(patch).filter((k) => k !== 'enrichment_status' && k !== 'enriched_at'),
    via_person: usedPersonId,
    usage: { credits, usd },
  });
}
