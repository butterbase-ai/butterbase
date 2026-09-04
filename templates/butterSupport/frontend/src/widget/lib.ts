export interface WidgetIdentity {
  user_id?: string;
  email?: string;
  name?: string;
}

export interface WidgetMessage {
  message_id: string;
  role: 'customer' | 'agent_draft' | 'founder' | 'system' | 'assistant';
  body: string;
  created_at: string;
  sender_name?: string;
}

const API_URL = (import.meta as any).env?.VITE_BUTTERBASE_API_URL || 'https://api.butterbase.ai';
// See console/lib/bb.ts for the rationale — prefer the meta tag rewritten at
// zip time so the same artifact serves every clone. Baked env stays as a
// dev-time fallback. Note: the widget also accepts data-app-id on its script
// tag, which trumps both of these (see the main script bootstrap).
function readBakedAppId(): string {
  try {
    const el = typeof document !== 'undefined'
      ? document.querySelector<HTMLMetaElement>('meta[name="butterbase-app-id"]')
      : null;
    const v = el?.content?.trim();
    if (v && v !== '__BB_APP_ID__') return v;
  } catch { /* ignore */ }
  return (import.meta as any).env?.VITE_BUTTERBASE_APP_ID || '';
}
const APP_ID_BAKED = readBakedAppId();
const SUBDOMAIN = (import.meta as any).env?.VITE_BUTTERBASE_SUBDOMAIN || '';

// Visitor token: random opaque string the widget mints once and stores in
// localStorage on the customer's origin. Sent in X-Butter-Visitor on every
// request. The server trusts it as a session key — there is no impersonation
// surface beyond stealing localStorage from the customer's site (same threat
// model as identified mode anyway, since identity is unverified).
const VISITOR_KEY_PREFIX = 'butter_visitor:';

function genVisitorToken(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  const b64 = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `v_${b64}`;
}

export function getVisitorToken(appId: string): string {
  const key = VISITOR_KEY_PREFIX + appId;
  try {
    const existing = localStorage.getItem(key);
    if (existing && /^v_[A-Za-z0-9_-]{20,80}$/.test(existing)) return existing;
    const fresh = genVisitorToken();
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    // localStorage blocked (private mode, sandboxed iframe). Fall back to an
    // in-memory token — history won't persist across reloads but the page
    // session still works.
    return genVisitorToken();
  }
}

async function call<T = any>(
  appId: string,
  visitorToken: string,
  fn: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  if (!appId) throw new Error('butterSupport: no app id (set data-app-id on the script tag)');
  const url = `${API_URL}/v1/${appId}/fn/${fn}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Visitor token in body, not a custom header — keeps the cross-origin
    // preflight a "simple" CORS request that the Butterbase edge already
    // allows (no custom-header whitelist needed).
    body: JSON.stringify({ visitor_token: visitorToken, ...body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${fn} ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

export function makeApi(appId: string, getIdentity: () => WidgetIdentity | null) {
  return {
    ingest(token: string, body: string, subject?: string) {
      return call<{ ticket_id: string; message_id?: string }>(appId, token, 'widget-ingest', {
        body,
        subject,
        identity: getIdentity() || undefined,
        client_message_id: `${token}-${Date.now()}`,
      });
    },
    followup(token: string, ticket_id: string, body: string) {
      return call<{ ok: true; ticket_id: string; message_id?: string; duplicate?: boolean }>(appId, token, 'widget-followup', {
        ticket_id,
        body,
        client_message_id: `${token}-${Date.now()}`,
      });
    },
    history(token: string, ticket_id?: string) {
      return call<{ tickets?: any[]; messages?: WidgetMessage[]; ticket_status?: string; ticket_id?: string }>(appId, token, 'widget-fetch-history', {
        ticket_id,
      });
    },
  };
}

export const APP_ID_FROM_ENV = APP_ID_BAKED;

// FE2: open a WebSocket to the WidgetTicketDO so the widget receives founder
// replies as push frames instead of polling every 5s. Auth via subprotocol —
// `?token=` is rejected cross-origin (CSRF) so we use `visitor.<token>` in
// Sec-WebSocket-Protocol, which the browser sets explicitly and CF accepts.
//
// Returns an object with { close } — caller invokes close() on cleanup.
// Frames the DO sends:
//   { type: 'hello', ticket_id }
//   { type: 'message', message_id, role, body, created_at, sender_name? }
//   { type: 'heartbeat_ack' }
//
// Fallback hook: pass onHello to be notified when the DO has accepted our
// subscription. If onHello hasn't fired after ~15s (corporate proxy strips
// WSS, sandboxed iframe blocks the upgrade, etc.) the caller can start a
// polling safety net via widget-fetch-history.
export function openWidgetWs(
  appId: string,
  ticketId: string,
  visitorToken: string,
  onMessage: (raw: any) => void,
  onHello?: () => void,
): { close: () => void } {
  const subdomain = SUBDOMAIN || appId.replace(/^app_/, '');
  const url = `wss://${subdomain}.butterbase.dev/_do/widget-ticket-do/${ticketId}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 1000;
  let reconnectTimer: number | null = null;
  let heartbeatTimer: number | null = null;

  function clearTimers() {
    if (reconnectTimer) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (heartbeatTimer) { window.clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(url, [`visitor.${visitorToken}`]);
    } catch (err) {
      // Browser rejected the subprotocol or URL — back off and retry.
      scheduleReconnect();
      return;
    }
    ws.addEventListener('open', () => {
      backoff = 1000;
      heartbeatTimer = window.setInterval(() => {
        try { ws?.send(JSON.stringify({ cmd: 'heartbeat' })); } catch { /* ignore */ }
      }, 25_000);
    });
    ws.addEventListener('message', (evt) => {
      let data: any;
      try { data = JSON.parse(typeof evt.data === 'string' ? evt.data : ''); } catch { return; }
      if (data?.type === 'hello') { onHello?.(); return; }
      if (data?.type === 'message') onMessage(data);
    });
    ws.addEventListener('close', () => {
      clearTimers();
      ws = null;
      scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // Most browsers fire close after error — let close handler reconnect.
    });
  }

  function scheduleReconnect() {
    if (closed) return;
    const delay = Math.min(backoff, 30_000);
    backoff = Math.min(backoff * 2, 30_000);
    reconnectTimer = window.setTimeout(connect, delay);
  }

  connect();

  return {
    close() {
      closed = true;
      clearTimers();
      try { ws?.close(); } catch { /* ignore */ }
      ws = null;
    },
  };
}
