function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

const AI_MODEL = "anthropic/claude-haiku-4.5";
const AI_TIMEOUT_MS = 8000;

function decodeJwtEmail(authHeader) {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1] + '==='.slice((parts[1].length + 3) % 4);
    const bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(bin);
    return typeof claims?.email === 'string' ? claims.email : null;
  } catch (err) {
    console.warn('mark-as-commitment: JWT decode failed', err?.message);
    return null;
  }
}

async function generateTitle(authHeader, apiUrl, appId, { customerName, customerEmail, ticketSubject, replyBody, dueAt }) {
  if (!authHeader || !apiUrl || !appId) return null;
  const dueLine = dueAt ? `\nDue: ${dueAt}` : '';
  const who = customerName || customerEmail || 'the customer';
  const userPrompt = [
    `Founder is committing to ${who} on a support ticket.`,
    `Ticket subject: ${ticketSubject || '(no subject)'}`,
    `Founder's reply (verbatim):`,
    `"""`, (replyBody || '').slice(0, 2000), `"""`,
    dueLine,
    '',
    'Write the commitment title now.',
  ].join('\n');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const r = await fetch(`${apiUrl}/v1/${appId}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 80,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You write a single-line commitment title: who commits what to whom, plus a due date if given. Concrete and specific — no marketing fluff. Maximum 90 characters. No quotes, no trailing period, no prefixes like "Commitment:" or "Title:". Output ONLY the title text.' },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!r.ok) { console.warn('mark-as-commitment: AI gateway non-2xx', r.status); return null; }
    const j = await r.json();
    const raw = j?.choices?.[0]?.message?.content || '';
    const cleaned = String(raw).trim().replace(/^["'`]+|["'`]+$/g, '').replace(/[.!?]+$/, '').slice(0, 120);
    return cleaned || null;
  } catch (err) {
    console.warn('mark-as-commitment: AI gateway threw', err?.message);
    return null;
  } finally { clearTimeout(t); }
}

function unwrapEntities(r) {
  if (Array.isArray(r)) return r;
  if (Array.isArray(r?.entities)) return r.entities;
  return [];
}

async function resolveFounderEntityId(ctx, email) {
  // 1. Try a true `self` entity.
  try {
    const arr = unwrapEntities(await ctx.substrate.findEntities({ type: 'self', limit: 1 }));
    if (arr[0]?.id) { console.info('founder via self entity', arr[0].id); return arr[0].id; }
  } catch (err) {
    console.warn('findEntities(self) threw', err?.message);
  }
  if (!email) { console.warn('no email available for founder lookup'); return null; }
  const lowerEmail = email.toLowerCase();
  const localPart = lowerEmail.split('@')[0];

  // 2. FTS lookup using the email local-part.
  try {
    const arr = unwrapEntities(await ctx.substrate.findEntities({ type: 'person', q: localPart, limit: 25 }));
    const hit = arr.find((e) => (e?.primary_email || '').toLowerCase() === lowerEmail);
    if (hit?.id) { console.info('founder via FTS local-part', hit.id); return hit.id; }
    console.warn('FTS local-part returned', arr.length, 'persons, no email match');
  } catch (err) {
    console.warn('findEntities(person, q=local) threw', err?.message);
  }

  // 3. List persons and exact-match primary_email.
  try {
    const arr = unwrapEntities(await ctx.substrate.findEntities({ type: 'person', limit: 200 }));
    const hit = arr.find((e) => (e?.primary_email || '').toLowerCase() === lowerEmail);
    if (hit?.id) { console.info('founder via list-all', hit.id, 'scanned', arr.length); return hit.id; }
    console.warn('founder not found in', arr.length, 'persons (looking for', lowerEmail, ')');
  } catch (err) {
    console.warn('findEntities(person, list-all) threw', err?.message);
  }
  return null;
}

export default async function handler(req, ctx) {
  if (!ctx.user) return json({ error: "unauthorized" }, 401);
  const authHeader = req.headers.get('authorization') || '';
  const founderEmail = decodeJwtEmail(authHeader);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const { ticket_id, message_id, due_date, due_at, title, content, source_artifact_id: callerArtifactId } = body || {};
  if (!ticket_id || !message_id) return json({ error: "missing_fields" }, 400);

  if (!(await ctx.idempotency.claim(`${ticket_id}:${message_id}`, { scope: "mark_commitment", ttlSeconds: 86400 }))) {
    return json({ ok: true, duplicate: true });
  }

  const t = await ctx.db.query(
    "SELECT id, customer_substrate_id, customer_email, customer_name, subject FROM support_tickets WHERE id = $1",
    [ticket_id]
  );
  if (t.rows.length === 0) return json({ error: "ticket_not_found" }, 404);
  const ticket = t.rows[0];

  const m = await ctx.db.query(
    "SELECT id, body, role FROM support_messages WHERE id = $1 AND ticket_id = $2",
    [message_id, ticket_id]
  );
  if (m.rows.length === 0) return json({ error: "message_not_found" }, 404);
  const msg = m.rows[0];

  const dueAtISO = due_at || due_date || null;

  let aiTitle = null;
  let aiUsed = false;
  if (!title || !String(title).trim()) {
    aiTitle = await generateTitle(authHeader, ctx.env.BUTTERBASE_API_URL, ctx.env.BUTTERBASE_APP_ID, {
      customerName: ticket.customer_name,
      customerEmail: ticket.customer_email,
      ticketSubject: ticket.subject,
      replyBody: msg.body,
      dueAt: dueAtISO,
    });
    aiUsed = !!aiTitle;
  }

  const finalTitle =
    (title && String(title).trim()) ||
    aiTitle ||
    (ticket.subject ? `Commitment: ${ticket.subject}`.slice(0, 120) : `Support commitment on ticket ${ticket_id}`);

  const replyExcerpt = (msg.body || '').slice(0, 4000) || `Founder commitment on ticket ${ticket_id}`;
  const customContent = content && String(content).trim();
  const finalContent = customContent || replyExcerpt;
  const description = customContent
    ? `${finalTitle}\n\n${finalContent}`.trim()
    : `${finalTitle}\n\n--- founder reply ---\n${finalContent}`.trim();

  const fromEntity = await resolveFounderEntityId(ctx, founderEmail);
  const sourceArtifactId = (callerArtifactId && String(callerArtifactId).trim()) || null;

  let toEntity = null;
  if (ticket.customer_substrate_id) {
    try {
      const ent = await ctx.substrate.getEntity(ticket.customer_substrate_id);
      if (ent?.id) toEntity = ticket.customer_substrate_id;
    } catch (err) {
      console.warn('customer_substrate_id stale, dropping to_entity', err?.message);
    }
  }

  const attrs = {
    title: finalTitle,
    ticket_id,
    message_id,
    source: 'support_recipe',
    customer_email: ticket.customer_email || null,
    ai_derived: aiUsed,
  };

  const buildPayload = (incTo, incArt, incFrom) => {
    const p = { description, status: 'confirmed', attrs };
    if (incFrom && fromEntity) p.from_entity = fromEntity;
    if (incTo && toEntity) p.to_entity = toEntity;
    if (incArt && sourceArtifactId) p.source_artifact_id = sourceArtifactId;
    if (dueAtISO) p.due_at = dueAtISO;
    return p;
  };

  const idempKey = `commit:${ticket_id}:${message_id}`;
  const tryPropose = (a, b, c) =>
    ctx.substrate.propose('record_commitment', buildPayload(a, b, c), { idempotency_key: idempKey });

  let substrateResult = null;
  let degraded = null;
  try {
    substrateResult = await tryPropose(true, true, true);
  } catch (err1) {
    console.warn('full propose failed, retry without source_artifact_id', err1?.message);
    degraded = 'no_source_artifact';
    try {
      substrateResult = await tryPropose(true, false, true);
    } catch (err2) {
      console.warn('retry failed, retry without to_entity', err2?.message);
      degraded = 'no_to_entity';
      try {
        substrateResult = await tryPropose(false, false, true);
      } catch (err3) {
        console.warn('retry failed, retry without from_entity', err3?.message);
        degraded = 'no_from_entity';
        try {
          substrateResult = await tryPropose(false, false, false);
        } catch (err4) {
          console.error('substrate.propose failed entirely', err4?.message);
          return json({ error: 'substrate_propose_failed', message: err4?.message }, 502);
        }
      }
    }
  }

  await ctx.db.query(
    `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, 'commitment.marked', 'support_ticket', $2::text, $3)`,
    [ctx.user.id, ticket_id, JSON.stringify({
      message_id, title: finalTitle, ai_derived: aiUsed,
      from_entity: fromEntity, to_entity: toEntity, source_artifact_id: sourceArtifactId,
      due_at: dueAtISO, degraded, substrate_action_id: substrateResult?.action_id,
    })]
  );

  return json({
    ok: true, title: finalTitle, ai_derived: aiUsed,
    from_entity: fromEntity, to_entity: toEntity, source_artifact_id: sourceArtifactId,
    degraded, substrate: substrateResult,
  });
}

