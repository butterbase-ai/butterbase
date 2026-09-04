import { DurableObject } from 'cloudflare:workers';

const MAX_INPUT_TOKENS = 150_000;
const MAX_OUTPUT_TOKENS = 15_000;
const MAX_LLM_CALLS = 25;
const LOCK_HEARTBEAT_MS = 60_000;
const RAG_TOP_K = 8;
const RAG_THRESHOLD = 0.6;
const RAG_CONFIDENT_THRESHOLD = 0.80;

const TOOLS = [
  { type: "function", function: { name: "search_docs",
      description: "Search the customer's help documentation. Returns ranked chunks with similarity scores. ALWAYS call this on the first turn.",
      parameters: { type: "object", required: ["query"],
        properties: {
          query: { type: "string", description: "Paraphrased question for semantic search" },
          top_k: { type: "integer", description: "Default 8" },
          threshold: { type: "number", description: "Min similarity, default 0.65" }
        } } } },
  { type: "function", function: { name: "propose_diagnosis",
      description: "Record your diagnosis of the issue. Call BEFORE drafting a reply.",
      parameters: { type: "object", required: ["summary", "confidence"],
        properties: {
          summary: { type: "string" },
          evidence: { type: "array", items: { type: "object" } },
          confidence: { type: "string", enum: ["low", "med", "high"] }
        } } } },
  { type: "function", function: { name: "propose_draft_reply",
      description: "Write the customer-facing reply. Founder reviews + approves. Include citation marks [1] [2] in body, list sources in citations.",
      parameters: { type: "object", required: ["body", "confidence"],
        properties: {
          body: { type: "string" },
          citations: { type: "array", items: { type: "object" } },
          confidence: { type: "string", enum: ["low", "med", "high"] }
        } } } },
  { type: "function", function: { name: "propose_escalation",
      description: "Hand off to a human. Use when docs returned nothing relevant, you can't form a confident diagnosis, or the customer asks something only a human can decide. Include a brief, warm `reply` (1-2 sentences) acknowledging the customer and saying a teammate will follow up — this is queued as a draft for founder approval.",
      parameters: { type: "object", required: ["reason"],
        properties: {
          reason:  { type: "string", description: "Internal note for the human — why this needs a human." },
          reply:   { type: "string", description: "Optional short customer-facing handoff message, 1-2 sentences. No apology spiral, no promises." },
          urgency: { type: "string", enum: ["low", "normal", "high", "urgent"] }
        } } } },
  { type: "function", function: { name: "request_followup_question",
      description: "Ask the customer for more info before diagnosing. Posts a question for founder approval.",
      parameters: { type: "object", required: ["question"],
        properties: { question: { type: "string" } } } } },
  { type: "function", function: { name: "propose_action",
      description: "Propose a side-effecting capability to substrate that needs founder approval (e.g. send_email_draft for a billing-credit acknowledgement). Creates a substrate ledger action AND a local agent_proposals row the founder can approve/reject. Use sparingly — most replies should go through propose_draft_reply.",
      parameters: { type: "object", required: ["capability", "payload", "rationale"],
        properties: {
          capability: { type: "string", description: "Substrate capability name (e.g. send_email_draft, record_commitment)" },
          payload: { type: "object", description: "Capability payload per substrate schema" },
          rationale: { type: "string", description: "Short note explaining why this action is needed for the ticket — shown to founder during review" }
        } } } },
  { type: "function", function: { name: "read_substrate",
      description: "Read from the founder's substrate (entities, memory, source artifacts). Use this BEFORE escalating when the customer asks about an order, account, invoice, shipment, person, or any business record the docs would not contain. Read-only — never mutates state.",
      parameters: { type: "object", required: ["action"],
        properties: {
          action: { type: "string", enum: ["findEntities", "getEntity", "searchMemory", "listSourceArtifactsHttp", "getSourceArtifactHttp"], description: "findEntities: list entities by type/query. getEntity: fetch one entity by id. searchMemory: free-text search across memory (and source_artifacts when kinds=['source_artifacts']). listSourceArtifactsHttp/getSourceArtifactHttp: source-artifact HTTP fallbacks." },
          params: { type: "object", description: "Action params. Common keys: type (e.g. 'person','order'), q/query (search text), entity_id/id, kinds (e.g. ['source_artifacts']), kind, limit (max 50)." }
        } } } }
];

const SYSTEM_PROMPT = `You are a support agent for a SaaS product. The founder reviews and approves your replies before they reach the customer.

PROCESS:
1. ALWAYS call search_docs on the first turn with a paraphrased version of the customer's question.
2. If top chunk score >= 0.80: propose_diagnosis (high), then propose_draft_reply with citations [1] [2].
3. If top chunk score 0.60-0.80: propose_diagnosis (low/med), then propose_draft_reply (low confidence).
4. If top chunk score < 0.60: BEFORE escalating, decide whether the question is about a customer-specific business record (order, account, invoice, shipment, person, commitment, prior agreement). If yes, call read_substrate (action=findEntities or searchMemory) to look it up — docs won't contain order #s or account-specific data. Only escalate if substrate also has nothing relevant or the customer needs a human decision. Use a brief, warm \`reply\` (1-2 sentences) on escalation.
5. If the customer's message is unclear: request_followup_question. Do not invent details.
6. If the customer needs a side-effecting action (issue a credit, send a follow-up email, record a commitment), call propose_action with the substrate capability + payload + a one-line rationale. The founder will see it in their queue and approve or reject. Do NOT use propose_action as a substitute for propose_draft_reply.

TONE: helpful, warm, concise. 2-3 sentences, roughly 40-60 words per reply unless the docs require steps. Never apologize excessively. Never invent facts not in the docs.

CONSTRAINTS:
- Never quote internal facts (other customers, internal metrics, founder notes).
- Never promise specific dates or amounts unless they're in the docs.
- When unsure, escalate with a soft handoff line rather than guessing.
- Use tools in sequence. After propose_draft_reply OR propose_escalation OR request_followup_question, STOP.`;

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

const HUMAN_REQUEST_REGEX = /\b(real|human|live)\s+(person|agent|support|rep|representative)\b|\bspeak\s+(to|with)\s+(a\s+)?(person|human|manager|supervisor|agent)\b|\bnot\s+(a\s+)?bot\b|\bdo\s+not\s+want\s+to\s+(?:talk|speak|chat)\s+to\s+(a\s+)?bot\b|\bdon[‘’]?t\s+want\s+to\s+(?:talk|speak|chat)\s+to\s+(a\s+)?bot\b|\bstop\s+(the\s+)?bot\b|\bpass\s+me\s+(to|on)\b/i;

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

const CLASSIFIER_PROMPT = `You classify a support ticket into ONE of these issue_types: ${CLASSIFIER_VOCABULARY.join(', ')}. Pick the SINGLE best match. If genuinely unclear, pick "other". Respond ONLY with a JSON object like {"issue_type":"billing"}. No prose, no markdown.`;

export class SupportTicketDO extends DurableObject {
  ticketId = null;
  threadId = null;
  driverWs = null;
  autonomyMode = 'draft_for_approval';

  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
  }

  async hydrateTicketId() {
    if (this.ticketId) return this.ticketId;
    try {
      const stored = await this.state.storage.get('ticket_id');
      if (stored) this.ticketId = stored;
    } catch (err) {
      console.error('[SupportTicketDO] hydrateTicketId failed', err?.message);
    }
    return this.ticketId;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    this.ticketId = parts[2] || null;
    if (!this.ticketId) return new Response('missing ticket_id', { status: 400 });
    try { await this.state.storage.put('ticket_id', this.ticketId); } catch {}

    if (req.headers.get('Upgrade') === 'websocket') {
      return await this.handleWsUpgrade(req);
    }

    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
    if (!token) return new Response('Unauthorized', { status: 401 });

    const internalToken = this.env.INTERNAL_TOKEN;
    let userId;
    if (internalToken && token === internalToken) {
      userId = 'internal';
    } else {
      userId = await this.verifyTeamMembership(token);
    }
    if (!userId) return new Response('Forbidden', { status: 403 });

    if (req.method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch {}
      if (body.cmd === 'startDiagnosis' || body.cmd === 'handleFollowup') {
        this.state.waitUntil(this.runAgentLoopSafe('diagnose', body.hint));
        return Response.json({ ok: true, kicked: body.cmd });
      }
    }

    return Response.json({ ok: true, ticket_id: this.ticketId, status: await this.getStatus() });
  }

  async handleWsUpgrade(req) {
    const url = new URL(req.url);
    let token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) token = url.searchParams.get('token');
    let requestedProtocol = null;
    if (!token) {
      const proto = req.headers.get('Sec-WebSocket-Protocol');
      if (proto) {
        const parts = proto.split(',').map(s => s.trim());
        for (const p of parts) {
          if (p.startsWith('bearer.')) { token = p.slice('bearer.'.length); requestedProtocol = p; break; }
        }
      }
    }
    if (!token) return new Response('Unauthorized', { status: 401 });

    const userId = await this.verifyTeamMembership(token);
    if (!userId) return new Response('Forbidden', { status: 403 });

    const now = Date.now();
    const lock = await this.state.storage.get('lock');
    if (lock && (now - lock.last_heartbeat) < LOCK_HEARTBEAT_MS && lock.user_id !== userId) {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      try {
        pair[1].send(JSON.stringify({ type: 'error', reason: 'driven_by_other_user', current_driver: lock.user_id }));
        pair[1].close(1008, 'driven_by_other_user');
      } catch {}
      const headers = requestedProtocol ? { 'Sec-WebSocket-Protocol': requestedProtocol } : undefined;
      return new Response(null, { status: 101, webSocket: pair[0], headers });
    }

    const sessionId = crypto.randomUUID();
    await this.state.storage.put('lock', { user_id: userId, session_id: sessionId, acquired_at: now, last_heartbeat: now });
    try { await this.state.storage.put('ticket_id', this.ticketId); } catch {}

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    this.driverWs = pair[1];

    pair[1].send(JSON.stringify({ type: 'hello', ticket_id: this.ticketId, session_id: sessionId, agent_state: await this.getStatus() }));
    const headers = requestedProtocol ? { 'Sec-WebSocket-Protocol': requestedProtocol } : undefined;
    return new Response(null, { status: 101, webSocket: pair[0], headers });
  }

  async webSocketMessage(ws, msg) {
    let data;
    try { data = JSON.parse(typeof msg === 'string' ? msg : new TextDecoder().decode(msg)); }
    catch { ws.send(JSON.stringify({ type: 'error', reason: 'invalid_json' })); return; }

    this.driverWs = ws;
    await this.hydrateTicketId();
    if (!this.ticketId) {
      ws.send(JSON.stringify({ type: 'error', reason: 'ticket_id_unresolved', message: 'DO woke without a stored ticket_id — please refresh the page.' }));
      return;
    }
    try {
      if (data.cmd === 'heartbeat') {
        const lock = await this.state.storage.get('lock');
        if (lock) { lock.last_heartbeat = Date.now(); await this.state.storage.put('lock', lock); }
        ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
        return;
      }
      if (data.cmd === 'diagnose') { this.state.waitUntil(this.runAgentLoopSafe('diagnose', data.hint)); return; }
      if (data.cmd === 'draft')    { this.state.waitUntil(this.runAgentLoopSafe('draft',    data.hint)); return; }
      if (data.cmd === 'rerun_with_hint') {
        try {
          const prior = await this.apiGet(`diagnoses?ticket_id=eq.${this.ticketId}&superseded_at=is.null&select=id`);
          const nowIso = new Date().toISOString();
          for (const d of (prior || [])) {
            await this.apiPatch('diagnoses', d.id, { superseded_at: nowIso }).catch((e) => {
              console.error('[SupportTicketDO] supersede prior diagnosis failed', d.id, e?.message);
            });
          }
        } catch (e) { console.error('[SupportTicketDO] rerun supersede lookup failed', e?.message); }
        this.state.waitUntil(this.runAgentLoopSafe('diagnose', data.hint));
        return;
      }
      if (data.cmd === 'escalate') { this.state.waitUntil(this.runAgentLoopSafe('escalate', data.reason)); return; }
      ws.send(JSON.stringify({ type: 'error', reason: 'unknown_cmd', cmd: data.cmd }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', reason: 'internal', message: String(err?.message || err) }));
    }
  }

  async webSocketClose() { this.driverWs = null; }
  async webSocketError() { this.driverWs = null; }

  emit(frame) {
    const sockets = this.state.getWebSockets ? this.state.getWebSockets() : (this.driverWs ? [this.driverWs] : []);
    for (const s of sockets) { try { s.send(JSON.stringify(frame)); } catch {} }
  }

  async logSystemError(stage, reason, detail) {
    const body = `Agent errored at ${stage}: ${reason}${detail ? ` — ${detail}`.slice(0, 600) : ''}`;
    console.error('[SupportTicketDO]', stage, reason, detail);
    try {
      await this.apiPost('support_messages', {
        ticket_id: this.ticketId,
        role: 'system',
        body
      });
    } catch (innerErr) {
      console.error('[SupportTicketDO] failed to log system error', innerErr?.message || innerErr);
    }
  }

  async verifyTeamMembership(jwt) {
    try {
      const r = await fetch(`${this.env.BUTTERBASE_API_URL}/auth/${this.env.BUTTERBASE_APP_ID}/me`, {
        headers: { 'Authorization': `Bearer ${jwt}` }
      });
      if (!r.ok) return null;
      const user = await r.json();
      const userId = user?.id || user?.user?.id;
      if (!userId) return null;
      const m = await fetch(`${this.env.BUTTERBASE_API_URL}/v1/${this.env.BUTTERBASE_APP_ID}/memberships?user_id=eq.${userId}&select=role`, {
        headers: this.apiHeaders()
      });
      if (!m.ok) return null;
      const rows = await m.json();
      return rows?.length > 0 ? userId : null;
    } catch (err) {
      console.error('verifyTeamMembership failed', err?.message);
      return null;
    }
  }

  apiHeaders() {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.env.BUTTERBASE_API_KEY}` };
  }

  async apiGet(path) {
    const r = await fetch(`${this.env.BUTTERBASE_API_URL}/v1/${this.env.BUTTERBASE_APP_ID}/${path}`, { headers: this.apiHeaders() });
    if (!r.ok) throw new Error(`GET ${path} ${r.status}: ${(await r.text().catch(() => '')).slice(0, 500)}`);
    return await r.json();
  }

  async apiPost(table, body) {
    const r = await fetch(`${this.env.BUTTERBASE_API_URL}/v1/${this.env.BUTTERBASE_APP_ID}/${table}`, {
      method: 'POST', headers: this.apiHeaders(), body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`POST ${table} ${r.status}: ${(await r.text().catch(() => '')).slice(0, 500)}`);
    return await r.json();
  }

  async apiPatch(table, id, body) {
    const r = await fetch(`${this.env.BUTTERBASE_API_URL}/v1/${this.env.BUTTERBASE_APP_ID}/${table}/${id}`, {
      method: 'PATCH', headers: this.apiHeaders(), body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`PATCH ${table}/${id} ${r.status}: ${(await r.text().catch(() => '')).slice(0, 500)}`);
    return await r.json();
  }

  async proposeToSubstrate(capability, payload, idempotencyKey) {
    const url = `${this.env.BUTTERBASE_API_URL}/v1/${this.env.BUTTERBASE_APP_ID}/fn/do-substrate-propose`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.env.BUTTERBASE_API_KEY}` },
      body: JSON.stringify(idempotencyKey ? { capability, payload, idempotency_key: idempotencyKey } : { capability, payload }),
    });
    const text = await r.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch {}
    if (!r.ok || parsed?.ok === false) {
      throw new Error(`substrate.propose ${capability} ${r.status}: ${(parsed?.error || text).toString().slice(0, 300)}`);
    }
    return parsed;
  }

  async toolRead_substrate(args) {
    const action = args?.action;
    const params = args?.params || {};
    if (!action) return { ok: false, error: 'missing action' };
    const url = `${this.env.BUTTERBASE_API_URL}/v1/${this.env.BUTTERBASE_APP_ID}/fn/substrate-read-internal`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.env.BUTTERBASE_API_KEY}` },
      body: JSON.stringify({ action, params }),
    });
    const text = await r.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch {}
    if (!r.ok) {
      return { ok: false, status: r.status, error: parsed?.error || text.slice(0, 300) };
    }
    return parsed ?? { ok: true };
  }

  async ensureThreadId() {
    if (this.threadId) return this.threadId;
    try {
      const rows = await this.apiGet(`agent_threads?ticket_id=eq.${this.ticketId}&select=id&limit=1`);
      if (rows?.[0]?.id) {
        this.threadId = rows[0].id;
        return this.threadId;
      }
    } catch (err) {
      console.error('[SupportTicketDO] ensureThreadId GET failed', err?.message);
    }
    try {
      const ins = await this.apiPost('agent_threads', {
        ticket_id: this.ticketId,
        do_instance_id: this.ticketId,
        status: 'idle'
      });
      const row = Array.isArray(ins) ? ins[0] : ins;
      this.threadId = row?.id || null;
    } catch (err) {
      console.error('[SupportTicketDO] ensureThreadId INSERT failed', err?.message);
      await this.logSystemError('ensureThreadId', 'insert_failed', String(err?.message));
    }
    return this.threadId;
  }

  async getStatus() {
    try {
      const rows = await this.apiGet(`agent_threads?ticket_id=eq.${this.ticketId}&select=status,last_event_at&limit=1`);
      return rows?.[0]?.status || 'idle';
    } catch { return 'unknown'; }
  }

  async setStatus(status) {
    try {
      const tid = this.threadId || await this.ensureThreadId();
      if (tid) {
        await this.apiPatch('agent_threads', tid, { status, last_event_at: new Date().toISOString() });
      } else {
        console.error('[SupportTicketDO] setStatus skipped — no thread id', status);
      }
    } catch (err) {
      console.error('[SupportTicketDO] setStatus failed', err?.message);
    }
    this.emit({ type: 'state', agent_state: status });
  }

  async getBudget() { return (await this.state.storage.get('budget')) || { input: 0, output: 0, calls: 0 }; }
  async addBudget(input, output) {
    const b = await this.getBudget();
    b.input += input; b.output += output; b.calls += 1;
    await this.state.storage.put('budget', b);
    return b;
  }
  budgetExceeded(b) {
    return b.input >= MAX_INPUT_TOKENS || b.output >= MAX_OUTPUT_TOKENS || b.calls >= MAX_LLM_CALLS;
  }

  async loadTicketContext() {
    const tickets = await this.apiGet(`support_tickets?id=eq.${this.ticketId}&select=id,customer_email,subject,status,customer_substrate_id,issue_type`);
    const messages = await this.apiGet(`support_messages?ticket_id=eq.${this.ticketId}&order=created_at.asc&select=role,body,created_at`);
    return { ticket: tickets?.[0], messages: messages || [] };
  }

  buildConversation(ctx, hint) {
    const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
    msgs.push({
      role: 'user',
      content: `Ticket id: ${ctx.ticket.id}\nCustomer email: ${ctx.ticket.customer_email}\nSubject: ${ctx.ticket.subject || '(none)'}\n\nConversation so far:\n` +
        ctx.messages.map(m => `[${m.role}]\n${m.body}`).join('\n\n') +
        (hint ? `\n\nFounder hint: ${hint}` : '')
    });
    return msgs;
  }

  async runAgentLoopSafe(mode, hint) {
    try {
      this.autonomyMode = 'draft_for_approval';
      await this.hydrateTicketId();
      if (!this.ticketId) {
        console.error('[SupportTicketDO] runAgentLoopSafe aborted — ticketId unresolved');
        this.emit({ type: 'error', reason: 'ticket_id_unresolved' });
        return;
      }
      await this.ensureThreadId();
      await this.runAgentLoop(mode, hint);
    } catch (err) {
      const msg = String(err?.message || err);
      console.error('[SupportTicketDO] runAgentLoop unhandled', mode, msg);
      this.emit({ type: 'error', reason: 'agent_loop_unhandled', message: msg });
      await this.logSystemError('runAgentLoop', 'unhandled_exception', msg);
      await this.setStatus('errored');
    }
  }

  async runAgentLoop(mode, hint) {
    await this.setStatus(mode === 'escalate' ? 'escalating' : (mode === 'draft' ? 'drafting' : 'diagnosing'));

    let tctx;
    try {
      tctx = await this.loadTicketContext();
    } catch (err) {
      this.emit({ type: 'error', reason: 'load_context_failed', message: String(err?.message) });
      await this.logSystemError('loadTicketContext', 'fetch_failed', String(err?.message));
      await this.setStatus('errored');
      return;
    }
    if (!tctx.ticket) {
      this.emit({ type: 'error', reason: 'ticket_not_found' });
      await this.logSystemError('loadTicketContext', 'ticket_not_found', this.ticketId);
      await this.setStatus('errored');
      return;
    }

    if (mode === 'escalate') {
      await this.toolPropose_escalation({ reason: hint || 'Founder forced escalation', urgency: 'normal' });
      await this.setStatus('done');
      return;
    }

    if (mode !== 'escalate') {
      try {
        const pre = await this.precheckForceEscalation();
        if (pre.escalate) {
          await this.toolPropose_escalation({ reason: `precheck: ${pre.reason}`, urgency: pre.urgency });
          await this.setStatus('done');
          return;
        }
      } catch (err) {
        console.error('[SupportTicketDO] precheck threw, continuing', err?.message);
      }

      let issueType = null;
      try {
        issueType = await this.classifyIssueType();
      } catch (err) {
        console.error('[SupportTicketDO] classify threw, continuing without issue_type', err?.message);
      }

      let autonomyMode = 'draft_for_approval';
      try {
        autonomyMode = await this.getAutonomyMode(issueType);
      } catch {}
      this.autonomyMode = autonomyMode;

      if (autonomyMode === 'force_escalate') {
        await this.toolPropose_escalation({
          reason: `autonomy_settings: issue_type=${issueType || 'unknown'} → force_escalate`,
          urgency: 'high'
        });
        await this.setStatus('done');
        return;
      }
    }

    const messages = this.buildConversation(tctx, hint);
    let done = false;
    let iter = 0;

    while (!done && iter < MAX_LLM_CALLS) {
      iter++;
      const budget = await this.getBudget();
      if (this.budgetExceeded(budget)) {
        await this.apiPost('support_messages', { ticket_id: this.ticketId, role: 'system', body: `Agent halted: budget cap reached (input=${budget.input}, output=${budget.output}, calls=${budget.calls}).` }).catch(() => {});
        await this.setStatus('errored');
        this.emit({ type: 'error', reason: 'budget_exhausted', budget });
        return;
      }

      let resp;
      try {
        const reqBody = { model: this.env.DEFAULT_MODEL, messages, tools: TOOLS, tool_choice: 'auto', max_tokens: 2048 };
        console.log('[SupportTicketDO] chat call iter', iter, 'model', this.env.DEFAULT_MODEL, 'msgs', messages.length);
        const r = await fetch(`${this.env.BUTTERBASE_API_URL}/v1/${this.env.BUTTERBASE_APP_ID}/chat/completions`, {
          method: 'POST', headers: this.apiHeaders(),
          body: JSON.stringify(reqBody)
        });
        if (!r.ok) {
          const errText = await r.text().catch(() => '');
          throw new Error(`AI ${r.status}: ${errText.slice(0, 500)}`);
        }
        resp = await r.json();
      } catch (err) {
        const msg = String(err?.message);
        this.emit({ type: 'error', reason: 'llm_call_failed', message: msg });
        await this.logSystemError('chat/completions', 'llm_call_failed', msg);
        await this.setStatus('errored');
        return;
      }

      const usage = resp.usage || {};
      await this.addBudget(usage.prompt_tokens || 0, usage.completion_tokens || 0);

      const choice = resp.choices?.[0];
      if (!choice) {
        this.emit({ type: 'error', reason: 'no_choice_returned' });
        await this.logSystemError('chat/completions', 'no_choice_returned', JSON.stringify(resp).slice(0, 300));
        await this.setStatus('errored');
        return;
      }
      const assistant = choice.message;
      messages.push(assistant);

      const tid = this.threadId || await this.ensureThreadId();
      if (tid) {
        try {
          await this.apiPost('agent_messages', {
            thread_id: tid,
            role: 'assistant',
            content: assistant.content || '',
            tool_calls: wrapJsonbArray(assistant.tool_calls),
            token_usage: emptyToNull(usage)
          });
        } catch (err) {
          const msg = String(err?.message || err);
          console.error('[SupportTicketDO] persist assistant turn failed', msg);
          await this.logSystemError('agent_messages', 'insert_failed', msg);
        }
      } else {
        console.error('[SupportTicketDO] persist assistant turn skipped — no thread id');
        await this.logSystemError('agent_messages', 'no_thread_id', this.ticketId);
      }

      this.emit({ type: 'agent_message', role: 'assistant', content: assistant.content || '', tool_calls: assistant.tool_calls || [] });

      if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
        done = true;
        break;
      }

      for (const tc of assistant.tool_calls) {
        const name = tc.function?.name;
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        this.emit({ type: 'tool_call_start', tool: name, args });

        let result;
        let terminates = false;
        try {
          if (name === 'search_docs') result = await this.toolSearch_docs(args);
          else if (name === 'propose_diagnosis') { result = await this.toolPropose_diagnosis(args); }
          else if (name === 'propose_draft_reply') { result = await this.toolPropose_draft_reply(args); terminates = true; }
          else if (name === 'propose_escalation') { result = await this.toolPropose_escalation(args); terminates = true; }
          else if (name === 'request_followup_question') { result = await this.toolRequest_followup(args); terminates = true; }
          else if (name === 'propose_action') { result = await this.toolPropose_action(args); }
          else if (name === 'read_substrate') { result = await this.toolRead_substrate(args); }
          else result = { error: 'unknown_tool' };
        } catch (err) {
          const msg = String(err?.message || err);
          result = { error: msg };
          console.error('[SupportTicketDO] tool failed', name, msg);
          await this.logSystemError(`tool:${name}`, 'exception', msg);
        }

        this.emit({ type: 'tool_call_result', tool: name, result });

        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });

        if (terminates) { done = true; }
      }
    }

    await this.setStatus(done ? 'done' : 'errored');
  }

  async toolSearch_docs(args) {
    const url = `${this.env.BUTTERBASE_API_URL}/v1/${this.env.BUTTERBASE_APP_ID}/rag/collections/${this.env.RAG_COLLECTION}/query`;
    const r = await fetch(url, {
      method: 'POST', headers: this.apiHeaders(),
      body: JSON.stringify({
        query: args.query,
        topK: args.top_k || RAG_TOP_K,
        threshold: args.threshold || RAG_THRESHOLD,
        synthesize: false
      })
    });
    if (!r.ok) return { error: `rag ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`, chunks: [] };
    const data = await r.json();
    const chunks = (data.chunks || data.results || []).map(c => ({
      text: (c.text || c.content || '').slice(0, 800),
      score: c.score || c.similarity || 0,
      metadata: c.metadata || {}
    }));
    const topScore = chunks[0]?.score || 0;
    return { chunks, top_score: topScore, confident: topScore >= RAG_CONFIDENT_THRESHOLD };
  }

  async toolPropose_diagnosis(args) {
    try {
      const prior = await this.apiGet(`diagnoses?ticket_id=eq.${this.ticketId}&superseded_at=is.null&select=id`);
      const nowIso = new Date().toISOString();
      for (const d of (prior || [])) {
        await this.apiPatch('diagnoses', d.id, { superseded_at: nowIso }).catch((e) => {
          console.error('[SupportTicketDO] supersede prior diagnosis failed', d.id, e?.message);
        });
      }
    } catch (e) { console.error('[SupportTicketDO] supersede lookup failed', e?.message); }

    const threadId = this.threadId || await this.ensureThreadId();

    const inserted = await this.apiPost('diagnoses', {
      ticket_id: this.ticketId,
      summary: args.summary,
      evidence: wrapJsonbArray(args.evidence || []),
      confidence: args.confidence || 'med',
      produced_by_thread_id: threadId
    });
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    this.emit({ type: 'diagnosis', diagnosis: row });

    let substrateActionId = null;
    try {
      const evidenceItems = Array.isArray(args.evidence) ? args.evidence : (args.evidence?.items || []);
      const content = [
        `# Support diagnosis`,
        `Ticket: ${this.ticketId}`,
        `Confidence: ${args.confidence || 'med'}`,
        ``,
        `## Summary`,
        args.summary || '',
        evidenceItems.length ? `\n## Evidence\n` + evidenceItems.map((e, i) => `${i+1}. ${e?.text || e?.title || JSON.stringify(e).slice(0,200)} (score=${e?.score ?? 'n/a'})`).join('\n') : '',
      ].join('\n');
      const verdict = await this.proposeToSubstrate('upsert_source_artifact', {
        kind: 'support_diagnosis',
        external_system: 'support_recipe',
        external_id: `${this.ticketId}:${row?.id}`,
        title: (args.summary || `Diagnosis on ticket ${this.ticketId}`).slice(0, 200),
        content,
        attrs: { ticket_id: this.ticketId, diagnosis_id: row?.id, confidence: args.confidence || 'med' },
      }, `support_diagnosis:${row?.id}`);
      substrateActionId = verdict?.action_id || null;
    } catch (err) {
      console.warn('[SupportTicketDO] propose_diagnosis: substrate projection failed', err?.message);
    }

    return { ok: true, diagnosis_id: row?.id, substrate_action_id: substrateActionId };
  }

  async toolPropose_action(args) {
    const threadId = this.threadId || await this.ensureThreadId();
    const { capability, payload, rationale } = args || {};
    if (!capability || !payload) return { ok: false, error: 'missing_capability_or_payload' };

    let verdict;
    try {
      verdict = await this.proposeToSubstrate(capability, payload, `agent_action:${this.ticketId}:${threadId}:${capability}`);
    } catch (err) {
      console.error('[SupportTicketDO] toolPropose_action: substrate propose failed', err?.message);
      await this.logSystemError('tool:propose_action', 'substrate_failed', err?.message);
      return { ok: false, error: err?.message };
    }

    let proposalRow = null;
    try {
      const ins = await this.apiPost('agent_proposals', {
        ticket_id: this.ticketId,
        thread_id: threadId,
        capability,
        payload,
        rationale: rationale || null,
        substrate_action_id: verdict?.action_id || null,
        status: verdict?.requires_approval === false ? 'approved' : 'pending',
        policy_verdict: verdict?.verdict || null,
      });
      proposalRow = Array.isArray(ins) ? ins[0] : ins;
    } catch (err) {
      console.error('[SupportTicketDO] toolPropose_action: agent_proposals insert failed', err?.message);
    }

    this.emit({
      type: 'proposal',
      proposal_id: proposalRow?.id,
      capability,
      substrate_action_id: verdict?.action_id,
      requires_approval: verdict?.requires_approval !== false,
    });

    return {
      ok: true,
      proposal_id: proposalRow?.id || null,
      substrate_action_id: verdict?.action_id || null,
      requires_approval: verdict?.requires_approval !== false,
      verdict: verdict?.verdict || null,
    };
  }

  async toolPropose_draft_reply(args) {
    const threadId = this.threadId || await this.ensureThreadId();

    const draftBody = (args.body || '') + (args.citations?.length ? `\n\n---\n` + args.citations.map((c, i) => `[${c.ref || i+1}] ${c.title || c.url || ''}`).join('\n') : '');

    const mode = this.autonomyMode || 'draft_for_approval';
    const role = mode === 'draft_for_approval' ? 'agent_draft' : 'founder';
    const nextStatus = mode === 'auto_resolve' ? 'resolved' : mode === 'auto_send' ? 'open' : 'awaiting_approval';

    const draftIns = await this.apiPost('support_messages', {
      ticket_id: this.ticketId,
      role,
      body: draftBody,
      drafted_by_thread_id: threadId
    });
    const row = Array.isArray(draftIns) ? draftIns[0] : draftIns;

    await this.apiPatch('support_tickets', this.ticketId, { status: nextStatus, last_message_at: new Date().toISOString() }).catch((e) => {
      console.error('[SupportTicketDO] patch ticket status failed', nextStatus, e?.message);
    });

    if (role === 'founder') {
      await this.pushToWidgetDo({
        message_id: row?.id,
        role: 'founder',
        body: draftBody,
        created_at: row?.created_at,
      });
    }

    this.emit({
      type: role === 'founder' ? 'auto_reply_sent' : 'draft_proposed',
      message: row,
      confidence: args.confidence,
      autonomy_mode: mode,
      new_status: nextStatus,
    });
    return {
      ok: true,
      draft_message_id: row?.id,
      role,
      new_status: nextStatus,
      autonomy_mode: mode,
      awaiting_approval: role === 'agent_draft',
    };
  }

  customerEscalationCopy(urgency, issueType) {
    const topic = issueType && issueType !== 'other' ? issueType.replace(/_/g, ' ') : 'this';
    if (urgency === 'urgent') {
      return `Thanks for reaching out — I'm passing this to a teammate right now. They'll follow up here as soon as possible (and via email if we have one on file).`;
    }
    return `Got it — I'm connecting you with a teammate who can help with ${topic}. They'll be in touch shortly here, and via email if we have one on file.`;
  }

  async pushToWidgetDo(frame) {
    const base = this.env.WIDGET_DO_BASE;
    const tok = this.env.INTERNAL_TOKEN;
    if (!base || !tok) return;
    try {
      const r = await fetch(`${base}/${this.ticketId}?cmd=push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify(frame),
      });
      if (!r.ok) {
        console.warn('[SupportTicketDO] widget-do push non-2xx', r.status);
      }
    } catch (err) {
      console.warn('[SupportTicketDO] widget-do push threw', err?.message);
    }
  }

  async toolPropose_escalation(args) {
    const tctx = await this.loadTicketContext();

    const handoffReply = (typeof args.reply === 'string' && args.reply.trim())
      || this.customerEscalationCopy(args.urgency, tctx.ticket?.issue_type);
    let handoffMessageId = null;
    let handoffCreatedAt = null;
    try {
      const ins = await this.apiPost('support_messages', {
        ticket_id: this.ticketId,
        role: 'founder',
        body: handoffReply,
      });
      const row = Array.isArray(ins) ? ins[0] : ins;
      handoffMessageId = row?.id || null;
      handoffCreatedAt = row?.created_at || null;
      this.emit({ type: 'agent_message', role: 'founder', content: handoffReply });
      await this.pushToWidgetDo({
        message_id: handoffMessageId,
        role: 'founder',
        body: handoffReply,
        created_at: handoffCreatedAt,
      });
    } catch (err) {
      console.error('[SupportTicketDO] toolPropose_escalation: handoff insert failed', err?.message);
    }

    let diagnosisSummary = null;
    let diagnosisConfidence = null;
    try {
      const diagnoses = await this.apiGet(`diagnoses?ticket_id=eq.${this.ticketId}&superseded_at=is.null&order=produced_at.desc&limit=1&select=summary,confidence`);
      diagnosisSummary = diagnoses?.[0]?.summary;
      diagnosisConfidence = diagnoses?.[0]?.confidence;
    } catch {}

    const ctxSnap = {
      who: tctx.ticket?.customer_email,
      subject: tctx.ticket?.subject,
      diagnosis: diagnosisSummary,
      diagnosis_confidence: diagnosisConfidence,
      reason: args.reason,
      urgency: args.urgency || 'normal'
    };

    let actionId = null;
    try {
      const verdict = await this.proposeToSubstrate('upsert_source_artifact', {
        kind: 'support_escalation',
        external_system: 'support_recipe',
        external_id: `${this.ticketId}:${Date.now()}`,
        title: `Escalation on ticket ${this.ticketId}`,
        content: [
          `# Escalation`,
          `Ticket: ${this.ticketId}`,
          `Urgency: ${args.urgency || 'normal'}`,
          ``,
          `## Reason (internal)`,
          args.reason || '',
          diagnosisSummary ? `\n## Latest diagnosis (${diagnosisConfidence})\n${diagnosisSummary}` : '',
        ].join('\n'),
        attrs: { ticket_id: this.ticketId, urgency: args.urgency || 'normal', reason: args.reason },
      });
      actionId = verdict?.action_id || null;
    } catch (err) {
      console.warn('[SupportTicketDO] toolPropose_escalation: substrate ledger entry failed, falling back to self-minted id', err?.message);
    }
    if (!actionId) {
      actionId = `escalate:${this.ticketId}:${Date.now()}:${crypto.randomUUID()}`;
    }

    const rawBody = JSON.stringify({
      action_id: actionId,
      payload: {
        ticket_id: this.ticketId,
        reason: args.reason,
        urgency: args.urgency || 'normal',
        context_snapshot: ctxSnap
      }
    });

    const secret = this.env.SUBSTRATE_OUTBOX_SECRET;
    if (!secret) {
      const err = 'SUBSTRATE_OUTBOX_SECRET not set on DO env';
      console.error('[SupportTicketDO] toolPropose_escalation:', err);
      await this.logSystemError('escalation', 'propose_failed', err);
      this.emit({ type: 'error', reason: 'escalation_propose_failed', message: err });
      return { ok: false, substrate_action_id: null, error: err };
    }

    let proposeError = null;
    let deliveryResult = null;
    try {
      const signature = await signOutboxBody(rawBody, secret);
      const url = `${this.env.BUTTERBASE_API_URL}/v1/${this.env.BUTTERBASE_APP_ID}/fn/execute-escalation`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Butterbase-Signature': signature },
        body: rawBody
      });
      if (res.ok) {
        deliveryResult = await res.json().catch(() => ({}));
        if (deliveryResult?.ok === false) {
          proposeError = `execute-escalation returned ok=false: ${deliveryResult?.result_for_ledger?.error || deliveryResult?.reason || 'unknown'}`;
        }
      } else {
        const txt = await res.text().catch(() => '');
        proposeError = `execute-escalation ${res.status}: ${txt.slice(0, 300)}`;
      }
    } catch (err) {
      proposeError = `escalation_delivery_threw: ${err?.message || err}`;
    }

    if (proposeError) {
      console.error('[SupportTicketDO] toolPropose_escalation failed', proposeError);
      await this.logSystemError('escalation', 'propose_failed', proposeError);
      this.emit({ type: 'error', reason: 'escalation_propose_failed', message: proposeError });
      return { ok: false, substrate_action_id: null, error: proposeError };
    }

    await this.apiPatch('support_tickets', this.ticketId, { status: 'escalated' }).catch((e) => {
      console.error('[SupportTicketDO] patch ticket escalated failed', e?.message);
    });
    this.emit({ type: 'escalation', reason: args.reason, urgency: args.urgency || 'normal', substrate_action_id: actionId, delivered: deliveryResult?.ok === true, handoff_message_id: handoffMessageId });
    return { ok: true, substrate_action_id: actionId, delivered: deliveryResult?.ok === true, handoff_message_id: handoffMessageId };
  }

  async toolRequest_followup(args) {
    const threadId = this.threadId || await this.ensureThreadId();

    const ins = await this.apiPost('support_messages', {
      ticket_id: this.ticketId,
      role: 'agent_draft',
      body: args.question,
      drafted_by_thread_id: threadId
    });
    const row = Array.isArray(ins) ? ins[0] : ins;
    await this.apiPatch('support_tickets', this.ticketId, { status: 'awaiting_approval' }).catch(() => {});
    this.emit({ type: 'followup_question_proposed', message: row });
    return { ok: true, draft_message_id: row?.id };
  }

  async precheckForceEscalation() {
    let messages;
    try {
      messages = await this.apiGet(`support_messages?ticket_id=eq.${this.ticketId}&order=created_at.desc&limit=20&select=role,body,created_at`);
    } catch (err) {
      console.error('[SupportTicketDO] precheckForceEscalation read failed', err?.message);
      return { escalate: false };
    }
    if (!Array.isArray(messages) || messages.length === 0) return { escalate: false };

    const customerMsgs = messages.filter(m => m.role === 'customer');
    const draftMsgs = messages.filter(m => m.role === 'agent_draft');
    const founderMsgs = messages.filter(m => m.role === 'founder');
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
        const ts = Date.parse(m.created_at);
        return Number.isFinite(ts) && ts >= cutoff;
      }).length;
      if (recentCustomerCount >= BURST_MIN_MSGS) {
        return { escalate: true, reason: `Customer sent ${recentCustomerCount} messages in ${BURST_MAX_AGE_MS / 60000} min with no founder reply.`, urgency: 'high' };
      }
    }

    let ticketStatus = null;
    try {
      const t = await this.apiGet(`support_tickets?id=eq.${this.ticketId}&select=status`);
      ticketStatus = t?.[0]?.status || null;
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

  async classifyIssueType() {
    let messages;
    try {
      messages = await this.apiGet(`support_messages?ticket_id=eq.${this.ticketId}&role=eq.customer&order=created_at.asc&limit=5&select=body`);
    } catch (err) {
      console.error('[SupportTicketDO] classifyIssueType read failed', err?.message);
      return null;
    }
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const sample = messages.map(m => m.body || '').join('\n---\n').slice(0, 2000);

    let resp;
    try {
      const r = await fetch(`${this.env.BUTTERBASE_API_URL}/v1/${this.env.BUTTERBASE_APP_ID}/chat/completions`, {
        method: 'POST', headers: this.apiHeaders(),
        body: JSON.stringify({
          model: 'anthropic/claude-haiku-4.5',
          max_tokens: 60,
          messages: [
            { role: 'system', content: CLASSIFIER_PROMPT },
            { role: 'user', content: sample }
          ]
        })
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.error('[SupportTicketDO] classifyIssueType LLM error', r.status, txt.slice(0, 200));
        return null;
      }
      resp = await r.json();
    } catch (err) {
      console.error('[SupportTicketDO] classifyIssueType LLM threw', err?.message);
      return null;
    }

    const raw = resp?.choices?.[0]?.message?.content || '';
    let parsed = null;
    try {
      const m = raw.match(/\{[^}]*"issue_type"[^}]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {}
    let label = (parsed && typeof parsed.issue_type === 'string') ? parsed.issue_type.toLowerCase().trim() : null;
    if (!label || !CLASSIFIER_VOCABULARY.includes(label)) {
      console.warn('[SupportTicketDO] classifyIssueType: rejected label', label, 'raw', raw.slice(0, 120));
      return null;
    }

    this.apiPatch('support_tickets', this.ticketId, { issue_type: label }).catch((e) => {
      console.error('[SupportTicketDO] classifyIssueType write failed', e?.message);
    });
    this.emit({ type: 'classified', issue_type: label });
    return label;
  }

  async getAutonomyMode(issueType) {
    try {
      if (issueType) {
        const r = await this.apiGet(`autonomy_settings?issue_type=eq.${encodeURIComponent(issueType)}&select=mode&limit=1`);
        if (r?.[0]?.mode) return r[0].mode;
      }
      const d = await this.apiGet(`autonomy_settings?issue_type=eq.default&select=mode&limit=1`);
      return d?.[0]?.mode || 'draft_for_approval';
    } catch (err) {
      console.error('[SupportTicketDO] getAutonomyMode failed', err?.message);
      return 'draft_for_approval';
    }
  }
}
