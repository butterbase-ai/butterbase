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
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

function isValidVisitorToken(t) {
  return typeof t === 'string' && /^v_[A-Za-z0-9_-]{20,80}$/.test(t);
}

export default async function handler(req, ctx) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  let body;
  try { body = await req.json(); } catch { body = {}; }

  const { visitor_token: visitorToken, limit, offset, ticket_id } = body || {};
  if (!isValidVisitorToken(visitorToken)) return json({ error: 'missing_visitor_token' }, 400);

  if (ticket_id) {
    const tid = String(ticket_id);
    const ticketCheck = await ctx.db.query(
      'SELECT id, status FROM support_tickets WHERE id = $1 AND visitor_token = $2 LIMIT 1',
      [tid, visitorToken],
    );
    if (ticketCheck.rows.length === 0) return json({ error: 'forbidden' }, 403);
    const ticket_status = ticketCheck.rows[0].status;

    const msgs = await ctx.db.query(
      `SELECT id, role, body, created_at
         FROM support_messages
        WHERE ticket_id = $1
          AND role IN ('customer','founder','system')
        ORDER BY created_at ASC
        LIMIT 100`,
      [tid],
    );

    return json({ ok: true, ticket_id: tid, ticket_status, messages: msgs.rows });
  }

  const lim = Math.max(1, Math.min(Number(limit) || 20, 100));
  const off = Math.max(0, Number(offset) || 0);

  const rows = await ctx.db.query(
    `SELECT id, subject, status, priority, opened_at, last_message_at
       FROM support_tickets
      WHERE visitor_token = $1
      ORDER BY last_message_at DESC
      LIMIT $2 OFFSET $3`,
    [visitorToken, lim, off],
  );

  return json({ ok: true, tickets: rows.rows, limit: lim, offset: off });
}

