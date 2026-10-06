import { DurableObject } from 'cloudflare:workers';

// Customer-facing WebSocket fan-out per ticket. Sibling to SupportTicketDO.
//
// Auth: visitor_token (from the widget's localStorage) must match the
// support_tickets.visitor_token row for the ticket id encoded in the URL.
// Stamped by widget-ingest at ticket creation.
//
// Push: server functions that write customer-visible messages
// (send-draft-reply, auto-reply-worker) reach this DO via ctx.invokeDO
// (native CF service binding), which arrives with URL host "do-internal".
// SupportTicketDO also uses the binding via env.WIDGET_TICKET_DO. The DO
// emits a {type:"message", ...} frame to every connected widget socket.
//
// Message-role filter: only roles the customer should see — 'customer',
// 'founder', 'system'. Never 'agent_draft' (in-flight), never 'assistant'
// (founder-only LLM turns), never 'tool' frames.
//
// Hibernation: state.acceptWebSocket means CF can evict the DO from memory
// while keeping the WS open. ticket_id is persisted to state.storage so a
// re-woken DO can still resolve itself. (Same lesson from SupportTicketDO LR9.)

const ALLOWED_ROLES = new Set(['customer', 'founder', 'system']);

export class WidgetTicketDO extends DurableObject {
  ticketId = null;
  visitorToken = null;

  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
  }

  async hydrate() {
    if (!this.ticketId) {
      try { this.ticketId = (await this.state.storage.get('ticket_id')) || null; }
      catch (err) { console.error('[WidgetTicketDO] hydrate ticket_id failed', err?.message); }
    }
    return this.ticketId;
  }

  async fetch(req) {
    const url = new URL(req.url);
    // ctx.invokeDO from functions arrives at:
    //   https://internal.butterbase/_dispatch/widget-ticket-do/{instance}
    //   with x-butterbase-internal-caller header set by the platform's do-invoker.
    // Native CF service bindings from sibling DOs (env.WIDGET_TICKET_DO.fetch)
    // arrive at whatever URL the caller supplied — we set "do-internal" for those.
    // Public HTTP arrives at /_do/widget-ticket-do/{ticket_id}.
    const invokerCaller = req.headers.get('x-butterbase-internal-caller') || null;
    const invokerInstance = req.headers.get('x-butterbase-instance') || null;
    const parts = url.pathname.split('/').filter(Boolean);
    this.ticketId = invokerInstance || parts[2] || null;

    let body = {};
    if (req.method === 'POST') {
      try { body = await req.json(); } catch {}
    }
    if (!this.ticketId && body?.ticket_id) this.ticketId = body.ticket_id;
    if (!this.ticketId) {
      try { this.ticketId = (await this.state.storage.get('ticket_id')) || null; } catch {}
    }
    if (!this.ticketId) return new Response('missing ticket_id', { status: 400 });
    try { await this.state.storage.put('ticket_id', this.ticketId); } catch {}

    const cmd = url.searchParams.get('cmd') || body?.cmd || null;

    // Server-to-DO push channel. Accepts three auth paths:
    //   1. ctx.invokeDO from a function — presence of x-butterbase-internal-caller.
    //   2. Native CF DO service binding from a sibling DO — URL host "do-internal".
    //   3. HTTP with Bearer BUTTERBASE_INTERNAL_FN_KEY — for direct HTTP callers.
    if (cmd === 'push' && req.method === 'POST') {
      const arrivedViaBinding = url.hostname === 'do-internal';
      const auth = req.headers.get('authorization') || '';
      const bearerOk = this.env.BUTTERBASE_INTERNAL_FN_KEY &&
        auth === `Bearer ${this.env.BUTTERBASE_INTERNAL_FN_KEY}`;
      if (!invokerCaller && !arrivedViaBinding && !bearerOk) {
        return new Response('unauthorized', { status: 401 });
      }
      const role = String(body?.role || '');
      if (!ALLOWED_ROLES.has(role)) {
        // Silently drop non-customer-visible roles so callers don't have to
        // think about the filter at the call site.
        return Response.json({ ok: true, dropped: true, role });
      }
      const frame = {
        type: 'message',
        message_id: body.message_id || body.id || null,
        role,
        body: body.body || '',
        created_at: body.created_at || new Date().toISOString(),
        sender_name: body.sender_name || null,
      };
      const sockets = this.state.getWebSockets ? this.state.getWebSockets() : [];
      let delivered = 0;
      for (const ws of sockets) {
        try { ws.send(JSON.stringify(frame)); delivered++; } catch {}
      }
      return Response.json({ ok: true, delivered });
    }

    if (req.headers.get('Upgrade') === 'websocket') {
      return await this.handleWsUpgrade(req);
    }

    return Response.json({ ok: true, ticket_id: this.ticketId });
  }

  async handleWsUpgrade(req) {
    const url = new URL(req.url);
    // Visitor token: prefer subprotocol (cross-origin-safe per LR9 finding),
    // fall back to ?visitor_token= query.
    let token = url.searchParams.get('visitor_token');
    let requestedProtocol = null;
    if (!token) {
      const proto = req.headers.get('Sec-WebSocket-Protocol');
      if (proto) {
        for (const p of proto.split(',').map((s) => s.trim())) {
          if (p.startsWith('visitor.')) {
            token = p.slice('visitor.'.length);
            requestedProtocol = p;
            break;
          }
        }
      }
    }
    if (!token || !/^v_[A-Za-z0-9_-]{20,80}$/.test(token)) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Verify the visitor owns this ticket.
    const ok = await this.verifyVisitor(this.ticketId, token);
    if (!ok) return new Response('Forbidden', { status: 403 });

    this.visitorToken = token;
    try { await this.state.storage.put('visitor_token', token); } catch {}

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    const headers = requestedProtocol ? { 'Sec-WebSocket-Protocol': requestedProtocol } : undefined;
    try {
      pair[1].send(JSON.stringify({ type: 'hello', ticket_id: this.ticketId }));
    } catch {}
    return new Response(null, { status: 101, webSocket: pair[0], headers });
  }

  async verifyVisitor(ticketId, visitorToken) {
    try {
      const url = `${this.env.BUTTERBASE_API_URL}/v1/${this.env.BUTTERBASE_APP_ID}/support_tickets?id=eq.${encodeURIComponent(ticketId)}&visitor_token=eq.${encodeURIComponent(visitorToken)}&select=id&limit=1`;
      // BUTTERBASE_API_KEY is gone from DO env; INTERNAL_FN_KEY is the
      // platform-injected bearer accepted on auto-REST CRUD.
      // Must use BUTTERBASE_API_KEY (bb_sk_ service key) not INTERNAL_FN_KEY:
      // the internal fn key is RLS-scoped, so this SELECT returns 0 rows even
      // when the row exists — WS upgrades then 403 for every real visitor.
      const r = await fetch(url, { headers: { Authorization: `Bearer ${this.env.BUTTERBASE_API_KEY}` } });
      if (!r.ok) {
        console.error('[WidgetTicketDO] verifyVisitor', r.status);
        return false;
      }
      const rows = await r.json();
      return Array.isArray(rows) && rows.length > 0;
    } catch (err) {
      console.error('[WidgetTicketDO] verifyVisitor threw', err?.message);
      return false;
    }
  }

  async webSocketMessage(ws, msg) {
    // Widget is subscribe-only. Accept heartbeats; ignore everything else.
    let data;
    try { data = JSON.parse(typeof msg === 'string' ? msg : new TextDecoder().decode(msg)); } catch { return; }
    if (data?.cmd === 'heartbeat') {
      try { ws.send(JSON.stringify({ type: 'heartbeat_ack' })); } catch {}
    }
  }

  async webSocketClose() { /* hibernation handles cleanup */ }
  async webSocketError() { /* hibernation handles cleanup */ }
}

