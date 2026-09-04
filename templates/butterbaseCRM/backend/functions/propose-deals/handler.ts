export async function handler(req, ctx) {
  if (!ctx.user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({
    proposed: 0,
    _note: 'propose-deals is stubbed; rewrite to source from substrate entities and write substrate ids into deal_proposals.company_substrate_id / person_substrate_id.',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
