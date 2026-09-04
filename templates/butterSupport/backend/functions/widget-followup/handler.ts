function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function isValidVisitorToken(t) {
  return typeof t === 'string' && /^v_[A-Za-z0-9_-]{20,80}$/.test(t);
}

async function fireSyncArtifact(ctx, ticketId) {
  try {
    const r = await ctx.invoke('sync-ticket-artifact', { ticket_id: ticketId });
    if (!r.ok) {
      console.warn('sync-ticket-artifact non-2xx', r.status, (await r.text().catch(() => '')).slice(0, 200));
    }
  } catch (err) {
    console.warn('sync-ticket-artifact invoke failed', err?.message);
  }
}

export default async function handler(req, ctx) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  let payload;
  try { payload = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const { visitor_token: visitorToken, ticket_id, body: messageText, client_message_id } = payload || {};
  if (!isValidVisitorToken(visitorToken)) return json({ error: 'missing_visitor_token' }, 400);
  if (!ticket_id || !messageText) return json({ error: 'missing_fields' }, 400);
  if (messageText.length > 8000) return json({ error: 'body_too_long' }, 413);

  const ticket = await ctx.db.query(
    'SELECT id, status, visitor_token FROM support_tickets WHERE id = $1',
    [ticket_id],
  );
  if (ticket.rows.length === 0) return json({ error: 'ticket_not_found' }, 404);
  if (ticket.rows[0].visitor_token !== visitorToken) return json({ error: 'ticket_not_yours' }, 403);
  // Only 'closed' is terminal. A 'resolved' ticket re-opens on customer follow-up
  // (the UPDATE below flips it back to 'open'). The prior guard rejected 'resolved'
  // with 409 and the re-open branch never ran — that was the bug the widget hit
  // when a customer sent one more question after clicking "Resolved".
  if (ticket.rows[0].status === 'closed') {
    return json({ error: 'ticket_closed', status: ticket.rows[0].status }, 409);
  }

  if (client_message_id) {
    if (!(await ctx.idempotency.claim(client_message_id, { scope: 'widget_followup', ttlSeconds: 24 * 3600 }))) {
      return json({ ok: true, duplicate: true });
    }
  }

  const inserted = await ctx.db.query(
    "INSERT INTO support_messages (ticket_id, role, body) VALUES ($1, 'customer', $2) RETURNING id",
    [ticket_id, messageText],
  );
  const messageId = inserted.rows[0]?.id;

  await ctx.db.query(
    `UPDATE support_tickets
       SET last_message_at = now(),
           status = CASE WHEN status IN ('sent','resolved') THEN 'open' ELSE status END,
           updated_at = now()
     WHERE id = $1`,
    [ticket_id],
  );

  await ctx.db.query(
    `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
     VALUES (NULL, 'ticket.followup', 'support_ticket', $1::text, $2)`,
    [ticket_id, JSON.stringify({ via: 'widget', visitor_token: visitorToken })],
  );

  ctx.waitUntil(fireSyncArtifact(ctx, ticket_id));

  ctx.waitUntil((async () => {
    // Platform-managed DO invocation. Replaces the prior HTTP + INTERNAL_TOKEN
    // pattern — no URL, no shared secret. Platform mints and injects the bearer.
    try {
      await ctx.invokeDO('support-ticket-do', ticket_id, { cmd: 'handleFollowup', ticket_id, message_text: messageText });
    } catch (err) {
      console.warn('support-ticket-do kick failed', err?.message);
    }
  })());

  // Return message_id so the widget can replace its optimistic `local-*` bubble
  // with the real UUID. Without this the WS echo / history poll appends the
  // same message a second time (dedupe is by message_id).
  return json({ ok: true, ticket_id, message_id: messageId });
}


