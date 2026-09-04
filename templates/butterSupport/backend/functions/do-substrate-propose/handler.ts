// Bridge from the SupportTicketDO (a Cloudflare Durable Object, no ctx.substrate
// and no ctx.invoke) to substrate.propose. Sibling functions should reach
// substrate via ctx.substrate.propose directly — this proxy exists only for
// callers that can't.
//
// Trigger.auth='none'; gate inside on ctx.caller.type. Allowed: loopback (if
// ever called via ctx.invoke), service_key (the DO's Bearer ${BUTTERBASE_API_KEY}).
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async function handler(req, ctx) {
  const t = ctx.caller?.type;
  if (t !== 'loopback' && t !== 'service_key') {
    return json({ error: 'forbidden', caller_type: t || null }, 403);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const { capability, payload, idempotency_key } = body || {};
  if (!capability || !payload) return json({ error: 'missing_fields' }, 400);

  try {
    const opts = idempotency_key ? { idempotency_key } : undefined;
    const result = await ctx.substrate.propose(capability, payload, opts);
    return json({ ok: true, ...result });
  } catch (err) {
    console.error('do-substrate-propose: propose failed', err?.message);
    return json({ ok: false, error: err?.message || String(err) }, 502);
  }
}
