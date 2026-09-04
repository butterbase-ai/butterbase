export async function handler(req, ctx) {
  if (!ctx.user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({
    counts: { companies_pairs_found: 0, people_pairs_found: 0, companies_evaluated: 0, people_evaluated: 0 },
    companies: [],
    people: [],
    _note: 'find-duplicates is stubbed; people/companies live in substrate now. Rewrite to scan listEntities and dedupe in JS.',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
