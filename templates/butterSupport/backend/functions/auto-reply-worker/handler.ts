function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

const RAG_COLLECTION = 'support-docs';
const MODEL = 'anthropic/claude-haiku-4.5';

const HUMAN_REQUEST_REGEX = /\b(real|human|live)\s+(person|agent|support|rep|representative)\b|\bspeak\s+(to|with)\s+(a\s+)?(person|human|manager|supervisor|agent)\b|\bnot\s+(a\s+)?bot\b|\bdo\s+not\s+want\s+to\s+(?:talk|speak|chat)\s+to\s+(a\s+)?bot\b|\bdon[''']?t\s+want\s+to\s+(?:talk|speak|chat)\s+to\s+(a\s+)?bot\b|\bstop\s+(the\s+)?bot\b|\bpass\s+me\s+(to|on)\b/i;

const ANGER_REGEX = /\b(ridiculous|unacceptable|disgusted|furious|outrageous|sue\s+you|lawyer|lawsuit|refund\s+me\s+now)\b/i;

function hasAllCapsBurst(text) {
  if (!text) return false;
  let run = 0;
  for (const word of text.split(/\s+/)) {
    const clean = word.replace(/[^A-Za-z]/g, '');
    if (clean.length >= 3 && clean === clean.toUpperCase() && /[A-Z]/.test(clean)) {
      run++;
      if (run >= 4) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

const BURST_MAX_AGE_MS = 10 * 60 * 1000;
const BURST_MIN_MSGS = 4;
const NTURNS_MIN_CUSTOMER = 3;
const NTURNS_MIN_DRAFTS = 2;
const NTURNS_TERMINAL_STATUSES = new Set(['resolved', 'escalated', 'closed', 'sent']);

const CLASSIFIER_VOCABULARY = [
  'billing', 'cancellation', 'refund_request', 'account_deletion',
  'data_privacy', 'security_incident', 'legal', 'complaint', 'outage',
  'password_reset', 'how_to', 'pricing_inquiry',
  'account_lockout', 'email_change', 'subscription_change',
  'bug_report', 'onboarding_help', 'feature_request',
  'other'
];

const CLASSIFIER_PROMPT = `You classify a support ticket into ONE of these issue_types: ${CLASSIFIER_VOCABULARY.join(', ')}. Pick the SINGLE best match based on the customer's MOST RECENT message — topics can shift mid-conversation (e.g. greeting → billing complaint). If genuinely unclear, pick "other". Respond ONLY with a JSON object like {"issue_type":"billing"}. No prose, no markdown.`;

function dimensionsToBullets(d) {
  if (!d || typeof d !== 'object') return '';
  const map = { tone: 'Tone', formality: 'Formality', response_length: 'Response length', always_cite: 'Always cite sources', sales_posture: 'Sales posture' };
  return Object.entries(d).filter(([k]) => map[k]).map(([k, v]) => `- ${map[k]}: ${v}`).join('\n');
}

function parseModelJson(raw) {
  if (!raw) return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1].trim();
  const lo = s.indexOf('{'); const hi = s.lastIndexOf('}');
  if (lo === -1 || hi <= lo) return null;
  s = s.slice(lo, hi + 1);
  try { return JSON.parse(s); } catch { return null; }
}

function sanitizeTopicTag(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  if (!cleaned || cleaned.length < 2) return null;
  return cleaned;
}

function fallbackSubject(messageText) {
  const oneLine = String(messageText || '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return 'Support request';
  return oneLine.length > 60 ? oneLine.slice(0, 57).trimEnd() + '…' : oneLine;
}

function wrapJsonbArray(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return { items: v };
  return v;
}
function emptyToNull(v) {
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return null;
  return v;
}

async function signOutboxBody(rawBody, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const hex = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
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

async function pushToWidgetDo(ctx, ticket_id, message) {
  // Platform-managed DO invocation. Replaces the prior WIDGET_DO_BASE HTTP
  // + INTERNAL_TOKEN pattern. The DO reads `cmd` from the body.
  try {
    await ctx.invokeDO('widget-ticket-do', ticket_id, { cmd: 'push', ticket_id, ...message });
  } catch (err) {
    console.warn('widget-do push threw', err?.message);
  }
}

function customerEscalationCopy(urgency, issueType) {
  const topic = issueType && issueType !== 'other' ? issueType.replace(/_/g, ' ') : 'this';
  if (urgency === 'urgent') {
    return `Thanks for reaching out — I'm passing this to a teammate right now. They'll follow up here as soon as possible (and via email if we have one on file).`;
  }
  return `Got it — I'm connecting you with a teammate who can help with ${topic}. They'll be in touch shortly here, and via email if we have one on file.`;
}

async function precheckForceEscalation(ctx, ticket_id) {
  let r;
  try {
    r = await ctx.db.query(
      `SELECT role, body, created_at FROM support_messages WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [ticket_id],
    );
  } catch (err) {
    console.warn('precheck read failed', err?.message);
    return { escalate: false };
  }
  const msgs = r.rows || [];
  if (msgs.length === 0) return { escalate: false };

  const customerMsgs = msgs.filter(m => m.role === 'customer');
  const draftMsgs = msgs.filter(m => m.role === 'agent_draft');
  const founderMsgs = msgs.filter(m => m.role === 'founder');
  const lastThreeCustomerBody = customerMsgs.slice(0, 3).map(m => m.body || '').join('\n');

  if (HUMAN_REQUEST_REGEX.test(lastThreeCustomerBody)) {
    return { escalate: true, reason: 'Customer explicitly requested a human agent.', urgency: 'urgent' };
  }
  if (ANGER_REGEX.test(lastThreeCustomerBody) || customerMsgs.slice(0, 3).some(m => hasAllCapsBurst(m.body))) {
    return { escalate: true, reason: 'Customer message detected as hostile (keyword or sustained ALL-CAPS).', urgency: 'urgent' };
  }
  if (founderMsgs.length === 0) {
    const cutoff = Date.now() - BURST_MAX_AGE_MS;
    const recentCustomerCount = customerMsgs.filter(m => {
      const ts = new Date(m.created_at).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    }).length;
    if (recentCustomerCount >= BURST_MIN_MSGS) {
      return { escalate: true, reason: `Customer sent ${recentCustomerCount} messages in ${BURST_MAX_AGE_MS / 60000} min with no founder reply.`, urgency: 'high' };
    }
  }
  let ticketStatus = null;
  try {
    const t = await ctx.db.query('SELECT status FROM support_tickets WHERE id = $1', [ticket_id]);
    ticketStatus = t.rows[0]?.status || null;
  } catch {}
  if (
    customerMsgs.length >= NTURNS_MIN_CUSTOMER &&
    draftMsgs.length >= NTURNS_MIN_DRAFTS &&
    !NTURNS_TERMINAL_STATUSES.has(ticketStatus)
  ) {
    return { escalate: true, reason: `${customerMsgs.length} customer turns + ${draftMsgs.length} agent drafts without resolution.`, urgency: 'high' };
  }
  return { escalate: false };
}

async function classifyIssueType(ctx, ticket_id, message_text) {
  let priorMsgs = [];
  try {
    const r = await ctx.db.query(
      `SELECT body FROM support_messages WHERE ticket_id = $1 AND role = 'customer' ORDER BY created_at DESC LIMIT 5`,
      [ticket_id],
    );
    priorMsgs = r.rows.map(x => x.body || '').reverse();
  } catch {}
  const corpus = [...priorMsgs, message_text].filter(Boolean).join('\n---\n').slice(-2000);
  if (!corpus) return null;
  const userPrompt = `Most recent customer message is the LAST one below. Classify based on it; earlier messages are only for context.\n\n${corpus}\n\nReturn the JSON classification now.`;

  let resp;
  try {
    const r = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 60,
        messages: [
          { role: 'system', content: CLASSIFIER_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!r.ok) {
      console.warn('classifier LLM error', r.status);
      return null;
    }
    resp = await r.json();
  } catch (err) {
    console.warn('classifier threw', err?.message);
    return null;
  }
  const raw = resp?.choices?.[0]?.message?.content || '';
  let parsed = null;
  try {
    const m = raw.match(/\{[^}]*"issue_type"[^}]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch {}
  const label = (parsed && typeof parsed.issue_type === 'string') ? parsed.issue_type.toLowerCase().trim() : null;
  if (!label || !CLASSIFIER_VOCABULARY.includes(label)) {
    console.warn('classifier rejected label', label, 'raw', raw.slice(0, 120));
    return null;
  }
  return label;
}

async function dispatchEscalation(ctx, ticket_id, reason, urgency, threadId, issueType) {
  const secret = ctx.env.SUBSTRATE_OUTBOX_SECRET;
  if (!secret) {
    console.error('auto-reply: SUBSTRATE_OUTBOX_SECRET not set — cannot escalate');
    return { ok: false, error: 'no_secret' };
  }
  const t = await ctx.db.query('SELECT customer_email, subject FROM support_tickets WHERE id = $1', [ticket_id]);
  const ticket = t.rows[0] || {};
  const actionId = `escalate:${ticket_id}:${Date.now()}:${crypto.randomUUID()}`;
  const ctxSnap = { who: ticket.customer_email, subject: ticket.subject, reason, urgency };
  const rawBody = JSON.stringify({
    action_id: actionId,
    payload: { ticket_id, reason, urgency, context_snapshot: ctxSnap },
  });
  let deliveryError = null;
  let deliveryResult = null;
  try {
    const signature = await signOutboxBody(rawBody, secret);
    const res = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/fn/execute-escalation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Butterbase-Signature': signature },
      body: rawBody,
    });
    if (res.ok) {
      deliveryResult = await res.json().catch(() => ({}));
      if (deliveryResult?.ok === false) {
        deliveryError = `execute-escalation returned ok=false: ${deliveryResult?.result_for_ledger?.error || deliveryResult?.reason || 'unknown'}`;
      }
    } else {
      const txt = await res.text().catch(() => '');
      deliveryError = `execute-escalation ${res.status}: ${txt.slice(0, 300)}`;
    }
  } catch (err) {
    deliveryError = `execute-escalation threw: ${err?.message || err}`;
  }

  const sysBody = deliveryError
    ? `Escalation attempted but delivery failed: ${deliveryError}`
    : `Escalation fired — reason: ${reason} (urgency: ${urgency})`;
  await ctx.db.query(
    `INSERT INTO support_messages (ticket_id, role, body) VALUES ($1, 'system', $2)`,
    [ticket_id, sysBody],
  ).catch(() => {});

  if (!deliveryError) {
    const friendly = customerEscalationCopy(urgency, issueType);
    let custMsg = null;
    try {
      const ins = await ctx.db.query(
        `INSERT INTO support_messages (ticket_id, role, body) VALUES ($1, 'founder', $2) RETURNING id, created_at`,
        [ticket_id, friendly],
      );
      custMsg = ins.rows[0];
    } catch (err) {
      console.warn('auto-reply: write customer escalation msg failed', err?.message);
    }
    if (custMsg) {
      await pushToWidgetDo(ctx, ticket_id, {
        message_id: custMsg.id,
        role: 'founder',
        body: friendly,
        created_at: custMsg.created_at,
      });
    }
  }

  if (!deliveryError) {
    await ctx.db.query(
      `UPDATE support_tickets SET status = 'escalated', last_message_at = now(), updated_at = now() WHERE id = $1`,
      [ticket_id],
    ).catch(() => {});
  }
  if (threadId) {
    await ctx.db.query(
      `UPDATE agent_threads SET status = $2, last_event_at = now() WHERE id = $1`,
      [threadId, deliveryError ? 'errored' : 'done'],
    ).catch(() => {});
  }
  await ctx.db.query(
    `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
     VALUES (NULL, $1, 'support_ticket', $2::text, $3)`,
    [
      deliveryError ? 'auto_reply.escalation_failed' : 'auto_reply.escalated',
      ticket_id,
      JSON.stringify({ action_id: actionId, reason, urgency, error: deliveryError }),
    ],
  ).catch(() => {});

  return { ok: !deliveryError, action_id: actionId, error: deliveryError };
}

export default async function handler(req, ctx) {
  // Trigger.auth='none'; gate inside on ctx.caller.type.
  // Allowed: loopback (widget-ingest, widget-followup via ctx.invoke), service_key (admin/MCP).
  const ct = ctx.caller?.type;
  if (ct !== 'loopback' && ct !== 'service_key') {
    return json({ error: 'forbidden', caller_type: ct || null }, 403);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const { ticket_id, message_text } = body || {};
  if (!ticket_id || !message_text) return json({ error: 'missing_fields' }, 400);

  const ticketR = await ctx.db.query(
    'SELECT id, issue_type, status, customer_name, customer_email, subject, topic_tag FROM support_tickets WHERE id = $1',
    [ticket_id],
  );
  if (ticketR.rows.length === 0) return json({ error: 'ticket_not_found' }, 404);
  const ticket = ticketR.rows[0];

  let threadId = null;
  try {
    const tr = await ctx.db.query('SELECT id FROM agent_threads WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 1', [ticket_id]);
    if (tr.rows.length > 0) {
      threadId = tr.rows[0].id;
    } else {
      const ins = await ctx.db.query(
        `INSERT INTO agent_threads (ticket_id, do_instance_id, status) VALUES ($1, $2::text, 'idle') RETURNING id`,
        [ticket_id, ticket_id],
      );
      threadId = ins.rows[0].id;
    }
    await ctx.db.query(`UPDATE agent_threads SET status = 'diagnosing', last_event_at = now() WHERE id = $1`, [threadId]);
  } catch (err) {
    console.warn('auto-reply: thread lookup/create failed', err?.message);
  }

  let issueType = ticket.issue_type || null;
  try {
    const fresh = await classifyIssueType(ctx, ticket_id, message_text);
    if (fresh) {
      issueType = fresh;
      await ctx.db.query('UPDATE support_tickets SET issue_type = $2 WHERE id = $1', [ticket_id, issueType]).catch(() => {});
    }
  } catch (err) {
    console.warn('classify threw', err?.message);
  }

  try {
    const pre = await precheckForceEscalation(ctx, ticket_id);
    if (pre.escalate) {
      const out = await dispatchEscalation(ctx, ticket_id, `precheck: ${pre.reason}`, pre.urgency, threadId, issueType);
      ctx.waitUntil(fireSyncArtifact(ctx, ticket_id));
      return json({ ok: true, escalated: true, route: 'precheck', delivered: out.ok, action_id: out.action_id, error: out.error });
    }
  } catch (err) {
    console.warn('precheck threw, continuing', err?.message);
  }

  const autonomyR = await ctx.db.query(
    `SELECT mode FROM autonomy_settings WHERE issue_type IN ('default', $1) ORDER BY (issue_type = $1) DESC LIMIT 1`,
    [issueType || 'default'],
  );
  const mode = autonomyR.rows[0]?.mode || 'draft_for_approval';

  if (mode === 'force_escalate') {
    const out = await dispatchEscalation(
      ctx, ticket_id,
      `autonomy_settings: issue_type=${issueType || 'unknown'} → force_escalate`,
      'high', threadId, issueType,
    );
    ctx.waitUntil(fireSyncArtifact(ctx, ticket_id));
    return json({ ok: true, escalated: true, route: 'autonomy', issue_type: issueType, delivered: out.ok, action_id: out.action_id, error: out.error });
  }

  const skillR = await ctx.db.query('SELECT dimensions, freeform_context FROM support_skill WHERE singleton = true LIMIT 1');
  const skill = skillR.rows[0] || { dimensions: {}, freeform_context: '' };

  const existingR = await ctx.db.query(
    `SELECT topic_tag,
            COUNT(*)::int AS n,
            (ARRAY_AGG(subject ORDER BY opened_at DESC) FILTER (WHERE subject IS NOT NULL))[1:2] AS sample_subjects
       FROM support_tickets
      WHERE topic_tag IS NOT NULL
        AND opened_at > now() - interval '30 days'
      GROUP BY topic_tag
      ORDER BY n DESC, topic_tag ASC
      LIMIT 30`,
  );
  const existingTagsBlock = existingR.rows.length
    ? existingR.rows.map((r) => {
        const samples = (r.sample_subjects || []).slice(0, 2).map((s) => `"${s}"`).join(', ');
        return `  - ${r.topic_tag} (used ${r.n}× — e.g. ${samples || '—'})`;
      }).join('\n')
    : '  (none yet — invent a fresh one)';

  let chunks = [];
  try {
    const ragRes = await fetch(
      `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/rag/collections/${RAG_COLLECTION}/query`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` }, body: JSON.stringify({ query: message_text, top_k: 5 }) },
    );
    if (ragRes.ok) {
      const j = await ragRes.json();
      const raw = j.chunks || j.results || [];
      chunks = raw.map((c) => ({
        text: typeof c.text === 'string' ? c.text.slice(0, 600) : typeof c.content === 'string' ? c.content.slice(0, 600) : '',
        score: typeof c.score === 'number' ? c.score : (typeof c.similarity === 'number' ? c.similarity : null),
        document_id: c.document_id || c.document?.id || null,
        filename: c.document?.filename || c.metadata?.filename || null,
      }));
    }
  } catch (err) {
    console.warn('rag query threw', err?.message);
  }
  const docsContext = chunks.length ? chunks.map((c, i) => `[doc ${i + 1}] ${c.text}`).join('\n\n') : '(no relevant docs found)';

  const needSubject = !ticket.subject || !String(ticket.subject).trim();

  const systemPrompt = [
    'You are the support assistant for this product. Reply to the customer using ONLY the provided docs as ground truth.',
    '',
    'STYLE:',
    dimensionsToBullets(skill.dimensions) || '- Tone: warm professional',
    skill.freeform_context ? `\nADDITIONAL CONTEXT:\n${skill.freeform_context}` : '',
    '',
    'REPLY RULES:',
    '- Address the customer directly. Be specific. Use short paragraphs.',
    '- If the docs do not cover the question, say so honestly and offer to escalate.',
    '- Never invent product features, prices, or policies.',
    '- No internal notes, no "as an AI" disclaimers.',
    '- Keep the reply under 200 words unless docs require more.',
    '',
    'TOPIC TAG (CLUSTERING) RULES:',
    'You will return a topic_tag — a stable canonical identifier used to GROUP this ticket with similar future tickets. The whole point is clustering, so YOU SHOULD STRONGLY PREFER REUSING AN EXISTING TAG.',
    '',
    'EXISTING TAGS IN USE (last 30 days):',
    existingTagsBlock,
    '',
    'How to choose:',
    '1. Read the customer message.',
    '2. Scan the existing tags above. For each, ask: "Could a reasonable operator file this ticket under this tag?" — including loosely related cases.',
    '3. If ANY existing tag could plausibly cover this message, REUSE IT EXACTLY. Even if it\'s not a perfect fit, prefer reuse over inventing a near-duplicate.',
    '4. Invent a brand-new tag ONLY when the message is on a topic genuinely not represented above.',
    '',
    'Tag format:',
    '- lowercase snake_case, 2–4 words, no customer-specific data, no numbers/dates.',
    '',
    'OUTPUT FORMAT — return ONLY a single JSON object, no prose, no fences:',
    '{',
    '  "subject":   "5-8 word title-case topic summary, no trailing period",',
    '  "topic_tag": "lowercase_snake_case_canonical_tag",',
    '  "reply":     "full reply to the customer"',
    '}',
  ].filter(Boolean).join('\n');

  const userPrompt = [
    `Customer ${ticket.customer_name ? `(${ticket.customer_name})` : ''}wrote:`,
    `"""`, message_text, `"""`,
    '',
    'RELEVANT DOCS:', docsContext,
    '',
    'Return the JSON now.',
  ].join('\n');

  let replyText = '', subjectFromModel = '', topicTagFromModel = '', aiError = null, rawLlmContent = '', usage = null;
  try {
    const aiRes = await fetch(
      `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/chat/completions`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
        body: JSON.stringify({ model: MODEL, max_tokens: 700, temperature: 0.2,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }) });
    if (!aiRes.ok) {
      aiError = `ai gateway ${aiRes.status}: ${(await aiRes.text().catch(() => '')).slice(0, 300)}`;
    } else {
      const j = await aiRes.json();
      usage = j?.usage || null;
      rawLlmContent = j?.choices?.[0]?.message?.content?.trim() || '';
      const parsed = parseModelJson(rawLlmContent);
      if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
        replyText = parsed.reply.trim();
        if (typeof parsed.subject === 'string') subjectFromModel = parsed.subject.trim().replace(/[.!?]+$/, '').slice(0, 120);
        if (typeof parsed.topic_tag === 'string') topicTagFromModel = sanitizeTopicTag(parsed.topic_tag) || '';
      } else {
        replyText = rawLlmContent;
      }
      if (!replyText) aiError = 'ai gateway returned empty content';
    }
  } catch (err) {
    aiError = `ai gateway threw: ${err?.message}`;
  }

  if (threadId) {
    try {
      const syntheticToolCallId = `auto_${Date.now()}`;
      const toolCalls = [{
        id: syntheticToolCallId,
        type: 'function',
        function: { name: 'search_docs', arguments: JSON.stringify({ query: message_text, top_k: 5 }) },
      }];
      const toolResults = [{
        tool_call_id: syntheticToolCallId,
        name: 'search_docs',
        result: { chunks, top_score: chunks[0]?.score ?? null },
      }];
      await ctx.db.query(
        `INSERT INTO agent_messages (thread_id, role, content, tool_calls, tool_results, token_usage)
         VALUES ($1, 'assistant', $2, $3, $4, $5)`,
        [
          threadId,
          rawLlmContent || (aiError ? `(error: ${aiError})` : ''),
          JSON.stringify(wrapJsonbArray(toolCalls)),
          JSON.stringify(wrapJsonbArray(toolResults)),
          usage ? JSON.stringify(emptyToNull(usage)) : null,
        ],
      );
    } catch (err) {
      console.warn('auto-reply: persist trace failed', err?.message);
    }
  }

  if (aiError || !replyText) {
    console.error('auto-reply failed', aiError);
    if (threadId) {
      await ctx.db.query(`UPDATE agent_threads SET status = 'errored', last_event_at = now() WHERE id = $1`, [threadId]).catch(() => {});
    }
    await ctx.db.query(
      `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
       VALUES (NULL, 'auto_reply.failed', 'support_ticket', $1::text, $2)`,
      [ticket_id, JSON.stringify({ error: aiError, mode, chunks: chunks.length })],
    );
    ctx.waitUntil(fireSyncArtifact(ctx, ticket_id));
    return json({ ok: false, error: aiError });
  }

  const role = mode === 'draft_for_approval' ? 'agent_draft' : 'founder';
  const msgIns = await ctx.db.query(
    `INSERT INTO support_messages (ticket_id, role, body, drafted_by_thread_id) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [ticket_id, role, replyText, threadId],
  );
  const messageId = msgIns.rows[0].id;
  const createdAt = msgIns.rows[0].created_at;

  const nextStatus = mode === 'auto_resolve' ? 'resolved' : mode === 'auto_send' ? 'open' : 'awaiting_approval';
  const subjectToWrite = needSubject ? (subjectFromModel || fallbackSubject(message_text)) : ticket.subject;
  await ctx.db.query(
    `UPDATE support_tickets
       SET status = $2, subject = $3, topic_tag = COALESCE($4, topic_tag),
           last_message_at = now(), updated_at = now()
     WHERE id = $1`,
    [ticket_id, nextStatus, subjectToWrite, topicTagFromModel || null],
  );

  if (threadId) {
    await ctx.db.query(`UPDATE agent_threads SET status = 'done', last_event_at = now() WHERE id = $1`, [threadId]).catch(() => {});
  }

  const existingTagsList = existingR.rows.map((r) => r.topic_tag);
  await ctx.db.query(
    `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
     VALUES (NULL, $1, 'support_ticket', $2::text, $3)`,
    [`auto_reply.${mode}`, ticket_id, JSON.stringify({
      message_id: messageId, model: MODEL, chunks: chunks.length, new_status: nextStatus,
      subject_written: needSubject ? subjectToWrite : null, topic_tag: topicTagFromModel || null,
      existing_tag_reused: topicTagFromModel && existingTagsList.includes(topicTagFromModel),
      thread_id: threadId, issue_type: issueType || null,
    })],
  );

  ctx.waitUntil(pushToWidgetDo(ctx, ticket_id, {
    message_id: messageId,
    role,
    body: replyText,
    created_at: createdAt,
  }));

  ctx.waitUntil(fireSyncArtifact(ctx, ticket_id));

  return json({ ok: true, message_id: messageId, role, new_status: nextStatus, chunks_used: chunks.length, mode, subject: subjectToWrite, topic_tag: topicTagFromModel || null, issue_type: issueType || null });
}


