function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

async function pushToWidgetDo(ctx, ticket_id, message) {
  // Platform-managed DO invocation. Replaces the prior WIDGET_DO_BASE HTTP
  // + INTERNAL_TOKEN pattern. The DO reads `cmd` from the body.
  try {
    await ctx.invokeDO('widget-ticket-do', ticket_id, { cmd: 'push', ticket_id, ...message });
  } catch (err) {
    console.warn('widget-do push threw', err?.message);
  }
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
  if (!ctx.user) return json({ error: "unauthorized" }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const { ticket_id, draft_message_id, edited_body, mark_as_resolved } = body || {};
  if (!ticket_id) return json({ error: "missing_ticket_id" }, 400);

  const ticket = await ctx.db.query(
    "SELECT id, customer_substrate_id, customer_email, subject, status FROM support_tickets WHERE id = $1",
    [ticket_id]
  );
  if (ticket.rows.length === 0) return json({ error: "ticket_not_found" }, 404);
  const t = ticket.rows[0];

  let finalBody = edited_body;
  let draft_id = null;
  if (draft_message_id) {
    const draft = await ctx.db.query(
      "SELECT id, body, role FROM support_messages WHERE id = $1 AND ticket_id = $2",
      [draft_message_id, ticket_id]
    );
    if (draft.rows.length === 0) return json({ error: "draft_not_found" }, 404);
    if (draft.rows[0].role !== "agent_draft") return json({ error: "not_a_draft", role: draft.rows[0].role }, 409);
    draft_id = draft.rows[0].id;
    if (!finalBody) finalBody = draft.rows[0].body;
  }
  if (!finalBody) return json({ error: "no_body" }, 400);

  const ins = await ctx.db.query(
    `INSERT INTO support_messages (ticket_id, role, body, drafted_by_user_id, parent_message_id)
     VALUES ($1, 'founder', $2, $3, $4)
     RETURNING id, created_at`,
    [ticket_id, finalBody, ctx.user.id, draft_id]
  );

  const newStatus = mark_as_resolved ? "resolved" : "sent";
  await ctx.db.query(
    `UPDATE support_tickets
        SET status = $1, last_message_at = now(), updated_at = now()
      WHERE id = $2`,
    [newStatus, ticket_id]
  );

  await ctx.db.query(
    `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, $2, 'support_ticket', $3::text, $4)`,
    [ctx.user.id, mark_as_resolved ? "ticket.resolved" : "ticket.reply_sent", ticket_id,
      JSON.stringify({ message_id: ins.rows[0].id, customer_email: t.customer_email })]
  );

  ctx.waitUntil(pushToWidgetDo(ctx, ticket_id, {
    message_id: ins.rows[0].id,
    role: "founder",
    body: finalBody,
    created_at: ins.rows[0].created_at,
  }));

  ctx.waitUntil(fireSyncArtifact(ctx, ticket_id));

  return json({
    ok: true,
    message_id: ins.rows[0].id,
    sent_at: ins.rows[0].created_at,
    ticket_status: newStatus,
  });
}


