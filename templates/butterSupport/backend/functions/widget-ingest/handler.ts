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

// Mirror of substrate-read-internal sanitizeQ. Substrate FTS treats an email
// as one un-indexed token; rewrite each email to its local part so the
// findEntities below can actually match.
function sanitizeQ(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw;
  s = s.replace(/([\w.+-]+)@[\w.-]+/g, ' $1 ');
  s = s.replace(/#/g, ' ');
  s = s.replace(/[,.;:!?()'"\/\\]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
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

  const { visitor_token: visitorToken, body: messageText, subject, identity, client_message_id } = payload || {};
  if (!isValidVisitorToken(visitorToken)) return json({ error: 'missing_visitor_token' }, 400);
  if (!messageText || typeof messageText !== 'string') return json({ error: 'missing_body' }, 400);
  if (messageText.length > 8000) return json({ error: 'body_too_long' }, 413);

  const ident = identity && typeof identity === 'object' ? identity : {};
  const customerEmail = ident.email ? String(ident.email).toLowerCase().slice(0, 320) : null;
  const customerName = ident.name ? String(ident.name).slice(0, 200) : null;
  const customerExternalId = ident.user_id ? String(ident.user_id).slice(0, 200) : null;

  if (client_message_id) {
    if (!(await ctx.idempotency.claim(client_message_id, { scope: 'widget_ingest', ttlSeconds: 24 * 3600 }))) {
      const existing = await ctx.db.query(
        `SELECT id AS ticket_id FROM support_tickets
          WHERE visitor_token = $1
          ORDER BY opened_at DESC LIMIT 1`,
        [visitorToken],
      );
      return json({ ok: true, duplicate: true, ticket_id: existing.rows[0]?.ticket_id || null });
    }
  }

  // Read-only entity resolution. Support NEVER writes person entities — CRM owns that.
  // If no match, customer_substrate_id stays null; the founder console surfaces this as "unknown customer".
  let customerSubstrateId = null;
  let entitySource = null;
  if (customerEmail) {
    try {
      const sanitizedQ = sanitizeQ(customerEmail);
      const entities = await ctx.substrate.findEntities({ type: 'person', q: sanitizedQ || customerEmail, limit: 5 });
      const match = (entities || []).find((e) =>
        (e?.attrs?.email || '').toLowerCase() === customerEmail ||
        (e?.canonical_keys?.email || '').toLowerCase() === customerEmail ||
        (e?.primary_email || '').toLowerCase() === customerEmail,
      );
      if (match?.id) {
        customerSubstrateId = match.id;
        entitySource = 'found';
      } else {
        entitySource = 'not_found';
      }
    } catch (err) {
      console.warn('widget-ingest: substrate findEntities failed', err?.message);
      entitySource = 'lookup_failed';
    }
  }

  // Seed subject from the first message body (truncated). The console's ticket
  // detail view runs a nicer AI-generated retitle async, but we still want a
  // sensible fallback so the inbox row never shows "(no subject)". Drop
  // newlines and collapse whitespace so the seed reads as a single phrase.
  const seededSubject =
    (typeof subject === 'string' && subject.trim())
      ? subject.trim().slice(0, 200)
      : messageText.replace(/\s+/g, ' ').trim().slice(0, 80);

  const ticketIns = await ctx.db.query(
    `INSERT INTO support_tickets
       (channel, visitor_token, identity_verified, customer_substrate_id,
        customer_email, customer_name, customer_external_id, subject, status)
     VALUES ('widget', $1, false, $2, $3, $4, $5, $6, 'open')
     RETURNING id, opened_at`,
    [visitorToken, customerSubstrateId, customerEmail, customerName, customerExternalId, seededSubject],
  );
  const ticketId = ticketIns.rows[0].id;

  // RETURNING id so we can echo the real UUID back to the widget — see the
  // corresponding note in widget-followup for why (optimistic-bubble dedupe).
  const messageIns = await ctx.db.query(
    "INSERT INTO support_messages (ticket_id, role, body) VALUES ($1, 'customer', $2) RETURNING id",
    [ticketId, messageText],
  );
  const messageId = messageIns.rows[0]?.id;

  await ctx.db.query(
    "INSERT INTO agent_threads (ticket_id, do_instance_id, status) VALUES ($1, $2::text, 'idle')",
    [ticketId, ticketId],
  );

  await ctx.db.query(
    `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
     VALUES (NULL, 'ticket.opened', 'support_ticket', $1::text, $2)`,
    [ticketId, JSON.stringify({
      via: 'widget',
      visitor_token: visitorToken,
      identity_verified: false,
      customer_email: customerEmail,
      customer_name: customerName,
      customer_external_id: customerExternalId,
      customer_substrate_id: customerSubstrateId,
      entity_source: entitySource,
    })],
  );

  ctx.waitUntil(fireSyncArtifact(ctx, ticketId));

  ctx.waitUntil((async () => {
    // Platform-managed DO invocation. Replaces the prior HTTP + INTERNAL_TOKEN
    // pattern — no URL, no shared secret. Platform mints and injects the bearer.
    try {
      await ctx.invokeDO('support-ticket-do', ticketId, { cmd: 'startDiagnosis', ticket_id: ticketId, message_text: messageText });
    } catch (err) {
      console.warn('support-ticket-do kick failed', err?.message);
    }
  })());

  return json({
    ok: true,
    ticket_id: ticketId,
    message_id: messageId,
    opened_at: ticketIns.rows[0].opened_at,
    customer_substrate_id: customerSubstrateId,
    entity_source: entitySource,
  });
}

