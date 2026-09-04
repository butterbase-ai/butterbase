// Enrich a person entity using the Butterbase People API.
//
// Strategy (best signal wins):
//   1. If person.attrs.linkedin_url is present  → get_profile(url) → fill fields.
//   2. Else if we have (first_name + last_name) + a linked company with a name
//      → search_person(current_company_name, currentRoleTitle=title?) → pick
//        best fuzzy name match → get_profile → fill fields.
//   3. Else → status = 'no_signal'.
//
// Writes go through ctx.substrate.propose('patch_entity', ...) — same pattern
// as resolve-pending-emails/handler.ts. We meter credits via the
// x-people-credits-consumed / x-people-usd-charged response headers (same
// as lead-search/handler.ts:255-265) and echo them back in the response so
// billing/telemetry stays consistent.

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function normStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

function fullNameFor(attrs: Record<string, any>): string | null {
  const f = normStr(attrs?.first_name);
  const l = normStr(attrs?.last_name);
  const combined = [f, l].filter(Boolean).join(' ').trim();
  return combined.length ? combined : null;
}

function nameMatchScore(candidate: any, first: string | null, last: string | null): number {
  const cFirst = normStr(candidate?.profile?.firstName)?.toLowerCase() ?? '';
  const cLast = normStr(candidate?.profile?.lastName)?.toLowerCase() ?? '';
  const cFull = normStr(candidate?.profile?.fullName)?.toLowerCase() ?? '';
  const wantFirst = first?.toLowerCase() ?? '';
  const wantLast = last?.toLowerCase() ?? '';
  let s = 0;
  if (wantFirst && cFirst === wantFirst) s += 2;
  else if (wantFirst && cFirst.startsWith(wantFirst)) s += 1;
  if (wantLast && cLast === wantLast) s += 2;
  else if (wantLast && cLast.startsWith(wantLast)) s += 1;
  if (wantFirst && wantLast && cFull.includes(`${wantFirst} ${wantLast}`)) s += 1;
  return s;
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
  const body: any = await res.json();
  const usage = body?.usage ?? {};
  const credits = Number.isFinite(Number(usage.creditsConsumed)) ? Number(usage.creditsConsumed) : (Number.isFinite(hdrCredits) ? hdrCredits : 0);
  const usd = Number.isFinite(Number(usage.usdCharged)) ? Number(usage.usdCharged) : (Number.isFinite(hdrUsd) ? hdrUsd : 0);
  return { data: body?.data ?? null, cached: !!usage.cached, credits, usd };
}

async function peopleSearchByCompanyName(ctx: any, companyName: string, roleTitle: string | null, pageSize = 25) {
  const body: Record<string, unknown> = {
    currentCompanyName: companyName,
    enrichProfiles: true,
    pageSize,
  };
  if (roleTitle) body.currentRoleTitle = roleTitle;
  const res = await fetch(
    `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/people/search/person`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
      body: JSON.stringify(body),
    },
  );
  const hdrCredits = Number(res.headers.get('x-people-credits-consumed') ?? NaN);
  const hdrUsd = Number(res.headers.get('x-people-usd-charged') ?? NaN);
  if (!res.ok) {
    const detail = await res.text();
    return { error: `people_search_${res.status}: ${detail.slice(0, 200)}` };
  }
  const j: any = await res.json();
  const usage = j?.usage ?? {};
  const credits = Number.isFinite(Number(usage.creditsConsumed)) ? Number(usage.creditsConsumed) : (Number.isFinite(hdrCredits) ? hdrCredits : 0);
  const usd = Number.isFinite(Number(usage.usdCharged)) ? Number(usage.usdCharged) : (Number.isFinite(hdrUsd) ? hdrUsd : 0);
  const results = Array.isArray(j?.data?.results) ? j.data.results : [];
  return { results, credits, usd };
}

function locationString(profile: any): string | null {
  const parts = [profile?.city, profile?.state, profile?.country].filter((s) => normStr(s));
  return parts.length ? parts.join(', ') : null;
}

function primaryExperience(profile: any): any | null {
  const exps = Array.isArray(profile?.experiences) ? profile.experiences : [];
  // The first entry (ends_at === null) is the current role.
  const current = exps.find((e: any) => e && e.ends_at == null);
  return current ?? exps[0] ?? null;
}

function buildPatch(profile: any): Record<string, any> {
  const patch: Record<string, any> = {};
  const first = normStr(profile?.firstName);
  const last = normStr(profile?.lastName);
  if (first) patch.first_name = first;
  if (last) patch.last_name = last;
  const exp = primaryExperience(profile);
  const title = normStr(exp?.title) ?? normStr(profile?.headline) ?? normStr(profile?.occupation);
  if (title) patch.title = title;
  const loc = locationString(profile);
  if (loc) patch.location = loc;
  const headline = normStr(profile?.headline);
  if (headline) patch.headline = headline;
  const summary = normStr(profile?.summary);
  if (summary) patch.bio = summary;
  return patch;
}

export async function handler(req: any, ctx: any) {
  if (!ctx.substrate) return json(503, { error: 'substrate_not_linked' });
  let body: any = {};
  try { body = await req.json(); } catch { /* GET / no body ok */ }
  const person_id: string | undefined = body?.person_id;
  if (!person_id) return json(400, { error: 'missing_person_id' });

  const person = await ctx.substrate.getEntity(person_id).catch(() => null);
  if (!person) return json(404, { error: 'person_not_found' });
  const attrs = (person.attrs ?? {}) as Record<string, any>;

  const linkedinUrl = normStr(attrs.linkedin_url);
  const first = normStr(attrs.first_name);
  const last = normStr(attrs.last_name);
  const enrichedAtISO = new Date().toISOString();

  let profile: any = null;
  let matchedLinkedinUrl: string | null = linkedinUrl;
  let credits = 0;
  let usd = 0;

  if (linkedinUrl) {
    const r = await peopleGetProfile(ctx, linkedinUrl);
    if ('error' in r) {
      await ctx.substrate.propose('patch_entity', {
        id: person_id,
        attrs_patch: { enrichment_status: `error:${r.error}`.slice(0, 200), enriched_at: enrichedAtISO },
      });
      return json(200, { ok: false, status: 'error', error: r.error });
    }
    profile = r.data;
    credits += r.credits;
    usd += r.usd;
  } else {
    // Fall back to a company-scoped search when we have enough signal.
    // Load the linked company for its name; without it we can't reliably match.
    const companyId = normStr(attrs.company_id);
    let companyName: string | null = normStr(attrs.company_name);
    if (companyId && !companyName) {
      const co = await ctx.substrate.getEntity(companyId).catch(() => null);
      companyName = normStr(co?.attrs?.name) ?? normStr(co?.display_name);
    }
    if (!companyName || !(first || last)) {
      await ctx.substrate.propose('patch_entity', {
        id: person_id,
        attrs_patch: { enrichment_status: 'no_signal', enriched_at: enrichedAtISO },
      });
      return json(200, { ok: true, status: 'no_signal', reason: 'need linkedin_url OR name+company' });
    }
    const search = await peopleSearchByCompanyName(ctx, companyName, normStr(attrs.title));
    if ('error' in search) {
      await ctx.substrate.propose('patch_entity', {
        id: person_id,
        attrs_patch: { enrichment_status: `error:${search.error}`.slice(0, 200), enriched_at: enrichedAtISO },
      });
      return json(200, { ok: false, status: 'error', error: search.error });
    }
    credits += search.credits;
    usd += search.usd;
    const scored = (search.results ?? [])
      .map((r: any) => ({ r, s: nameMatchScore(r, first, last) }))
      .filter((x) => x.s >= 2)
      .sort((a, b) => b.s - a.s);
    const top = scored[0]?.r;
    const foundUrl = normStr(top?.linkedinProfileUrl);
    if (!top || !foundUrl || !/^https?:\/\/([a-z0-9-]+\.)?linkedin\.com\/in\//i.test(foundUrl)) {
      await ctx.substrate.propose('patch_entity', {
        id: person_id,
        attrs_patch: { enrichment_status: 'no_match', enriched_at: enrichedAtISO },
      });
      return json(200, { ok: true, status: 'no_match', tried: search.results?.length ?? 0 });
    }
    matchedLinkedinUrl = foundUrl;
    // Search already returned a 'profile' block; hydrate a full profile via get_profile so
    // we get the richer bio/experiences/etc. — one extra request but consistent output.
    const r = await peopleGetProfile(ctx, foundUrl);
    if ('error' in r) {
      // Fall back to the (thinner) search-embedded profile so we don't waste the search.
      profile = { ...(top.profile ?? {}), firstName: top.profile?.firstName, lastName: top.profile?.lastName };
    } else {
      profile = r.data;
      credits += r.credits;
      usd += r.usd;
    }
  }

  if (!profile) {
    await ctx.substrate.propose('patch_entity', {
      id: person_id,
      attrs_patch: { enrichment_status: 'no_match', enriched_at: enrichedAtISO },
    });
    return json(200, { ok: true, status: 'no_match' });
  }

  const patch = buildPatch(profile);
  if (matchedLinkedinUrl && !linkedinUrl) patch.linkedin_url = matchedLinkedinUrl;
  patch.enrichment_status = 'people_api_ok';
  patch.enriched_at = enrichedAtISO;

  await ctx.substrate.propose('patch_entity', {
    id: person_id,
    attrs_patch: patch,
  });

  console.log(JSON.stringify({ evt: 'enrich_person_usage', person_id, credits, usd, fields: Object.keys(patch).length - 2 }));
  return json(200, {
    ok: true,
    status: 'people_api_ok',
    patched_fields: Object.keys(patch).filter((k) => k !== 'enrichment_status' && k !== 'enriched_at'),
    usage: { credits, usd },
  });
}
