export async function handler(req, ctx) {
  return new Response(JSON.stringify({
    ok: true, enriched: 0, _note: 'trigger-enrichment stubbed pending substrate rewrite.',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
