function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handler(req, ctx) {
  if (!ctx.user) return jsonResponse(401, { error: 'unauthorized' });
  if (!ctx.substrate) return jsonResponse(503, { error: 'substrate_not_linked' });

  let body;
  try { body = await req.json(); } catch { body = {}; }

  const type = body?.type;
  const q = body?.q;
  const limit = Math.min(Math.max(Number(body?.limit) || 20, 1), 100);

  if (type && type !== 'company' && type !== 'person') {
    return jsonResponse(400, { error: 'type must be "company" or "person" or omitted' });
  }

  try {
    const entities = await ctx.substrate.findEntities({
      type: type ?? undefined,
      q: typeof q === 'string' && q.length > 0 ? q : undefined,
      limit,
    });
    return jsonResponse(200, { entities });
  } catch (e) {
    return jsonResponse(502, { error: 'substrate_find_failed', detail: String(e?.message ?? e) });
  }
}

