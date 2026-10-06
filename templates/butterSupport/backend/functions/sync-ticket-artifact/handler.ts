function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function isoize(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  try { return new Date(v).toISOString(); } catch { return null; }
}

function safeJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

const MAX_CONTENT_CHARS = 100_000;
const MAX_BODY_CHARS = 4_000;

function buildContent(ticket, messages) {
  const header = ticket.subject ? `# ${ticket.subject}` : '# Support ticket';
  const meta = [
    ticket.customer_email ? `Customer: ${ticket.customer_email}${ticket.customer_name ? ` (${ticket.customer_name})` : ''}` : null,
    ticket.status ? `Status: ${ticket.status}` : null,
    ticket.issue_type ? `Issue type: ${ticket.issue_type}` : null,
    ticket.topic_tag ? `Topic tag: ${ticket.topic_tag}` : null,
  ].filter(Boolean).join('\n');

  const transcript = messages.map((m) => {
    const ts = isoize(m.created_at) || '';
    const body = (m.body || '').slice(0, MAX_BODY_CHARS);
    return `--- [${m.role} @ ${ts}] ---\n${body}`;
  }).join('\n\n');

  const out = [header, meta, '', transcript].filter(Boolean).join('\n');
  return out.length > MAX_CONTENT_CHARS ? out.slice(0, MAX_CONTENT_CHARS) + '\n…[truncated]' : out;
}

// Trigger.auth='none' — gating is done inside on ctx.caller.type.
// Allowed: loopback (sibling ctx.invoke), service_key (DO + admin),
// cron (scheduled triggers). End-user JWTs are rejected.
function isAuthorizedCaller(ctx) {
  const t = ctx.caller?.type;
  return t === 'loopback' || t === 'service_key' || t === 'cron';
}

export default async function handler(req, ctx) {
  if (!isAuthorizedCaller(ctx)) {
    return json({ error: 'forbidden', caller_type: ctx.caller?.type || null }, 403);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const ticketId = body?.ticket_id;
  if (!ticketId || typeof ticketId !== 'string') return json({ error: 'missing_ticket_id' }, 400);

  const tr = await ctx.db.query(
    `SELECT id, customer_email, customer_name, customer_external_id, subject, status,
            issue_type, topic_tag, customer_substrate_id, identity_verified,
            opened_at, last_message_at, updated_at, visitor_token
       FROM support_tickets WHERE id = $1`,
    [ticketId],
  );
  if (tr.rows.length === 0) return json({ error: 'ticket_not_found' }, 404);
  const ticket = tr.rows[0];

  const mr = await ctx.db.query(
    `SELECT id, role, body, created_at
       FROM support_messages
      WHERE ticket_id = $1
      ORDER BY created_at ASC, id ASC`,
    [ticketId],
  );
  const messages = mr.rows;

  let diagnoses = [];
  try {
    const dr = await ctx.db.query(
      `SELECT id, summary, confidence, evidence, produced_at, superseded_at
         FROM diagnoses WHERE ticket_id = $1
         ORDER BY produced_at ASC`,
      [ticketId],
    );
    diagnoses = dr.rows;
  } catch (err) {
    console.warn('sync-ticket-artifact: diagnoses read failed', err?.message);
  }
  const currentDiagnosis = [...diagnoses].reverse().find((d) => !d.superseded_at) || null;

  let escalations = [];
  try {
    const er = await ctx.db.query(
      `SELECT id, target_id, reason, status, error, sent_at, context_snapshot, created_at,
              substrate_action_id
         FROM escalations WHERE ticket_id = $1
         ORDER BY created_at ASC`,
      [ticketId],
    );
    escalations = er.rows;
  } catch (err) {
    console.warn('sync-ticket-artifact: escalations read failed', err?.message);
  }

  const attrs = {
    status: ticket.status,
    issue_type: ticket.issue_type || null,
    topic_tag: ticket.topic_tag || null,
    identity_verified: !!ticket.identity_verified,
    opened_at: isoize(ticket.opened_at),
    last_message_at: isoize(ticket.last_message_at),
    updated_at: isoize(ticket.updated_at),
    message_count: messages.length,
    customer: {
      email: ticket.customer_email,
      name: ticket.customer_name,
      external_id: ticket.customer_external_id,
    },
    current_diagnosis: currentDiagnosis
      ? {
          id: currentDiagnosis.id,
          summary: currentDiagnosis.summary,
          confidence: currentDiagnosis.confidence,
          produced_at: isoize(currentDiagnosis.produced_at),
        }
      : null,
    diagnosis_history: diagnoses.map((d) => ({
      id: d.id,
      summary: d.summary,
      confidence: d.confidence,
      produced_at: isoize(d.produced_at),
      superseded_at: isoize(d.superseded_at),
    })),
    escalations: escalations.map((e) => {
      const snap = safeJson(e.context_snapshot) || {};
      return {
        id: e.id,
        substrate_action_id: e.substrate_action_id || null,
        reason: e.reason,
        urgency: snap.urgency || null,
        status: e.status,
        error: e.error || null,
        sent_at: isoize(e.sent_at),
        created_at: isoize(e.created_at),
      };
    }),
    source: 'support_recipe',
  };

  const title =
    ticket.subject ||
    (ticket.customer_email ? `Support: ${ticket.customer_email}` : 'Support: visitor');

  const content = buildContent(ticket, messages);

  const links = ticket.customer_substrate_id
    ? { entity_ids: [ticket.customer_substrate_id] }
    : {};

  try {
    const result = await ctx.substrate.propose('upsert_source_artifact', {
      kind: 'support_ticket',
      external_system: 'support_recipe',
      external_id: ticketId,
      title,
      content,
      attrs,
      links,
    });
    return json({
      ok: true,
      action_id: result?.action_id || null,
      artifact_id: result?.result?.artifact_id || null,
      message_count: messages.length,
      diagnosis_count: diagnoses.length,
      escalation_count: escalations.length,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn('sync-ticket-artifact: substrate propose failed', msg);
    return json({ ok: false, error: msg }, 502);
  }
}
