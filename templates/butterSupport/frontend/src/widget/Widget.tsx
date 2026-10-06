import { useEffect, useMemo, useRef, useState } from 'react';
import { LauncherButton } from './components/LauncherButton';
import { WidgetPanel } from './components/WidgetPanel';
import { getVisitorToken, makeApi, openWidgetWs, type WidgetIdentity, type WidgetMessage } from './lib';

function normalizeMessage(raw: any): WidgetMessage {
  return {
    message_id: raw.message_id || raw.id,
    role: raw.role,
    body: raw.body,
    created_at: raw.created_at,
    sender_name: raw.sender_name,
  };
}

interface WidgetProps {
  appId: string;
}

export function Widget({ appId }: WidgetProps) {
  const visitorToken = useMemo(() => getVisitorToken(appId), [appId]);
  const identityRef = useRef<WidgetIdentity | null>(null);
  const api = useMemo(() => makeApi(appId, () => identityRef.current), [appId]);

  const [open, setOpen] = useState(false);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [ticketStatus, setTicketStatus] = useState<string | null>(null);
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Public API on window.ButterSupport. identify() stores identity for use on
  // the next widget call; open()/close()/toggle() drive the launcher.
  useEffect(() => {
    const w = window as any;
    const prev = w.ButterSupport;
    const queue: any[] = Array.isArray(prev?.q) ? prev.q : [];

    const support = {
      identify(next: WidgetIdentity | null) {
        identityRef.current = next || null;
      },
      open() { setOpen(true); },
      close() { setOpen(false); },
      toggle() { setOpen((o) => !o); },
      reset() {
        identityRef.current = null;
        setTicketId(null);
        setTicketStatus(null);
        setMessages([]);
      },
    };

    w.ButterSupport = support;

    // Flush any queued calls made before the bundle loaded.
    // Convention: window.ButterSupport.q.push(['identify', {...}])
    for (const entry of queue) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const [method, ...args] = entry;
      const fn = (support as any)[method];
      if (typeof fn === 'function') {
        try { fn.apply(support, args); } catch { /* ignore */ }
      }
    }

    return () => {
      // Replace with a no-op shim so a host that cached the object doesn't crash.
      w.ButterSupport = { identify() {}, open() {}, close() {}, toggle() {}, reset() {}, q: [] };
    };
  }, []);

  async function loadHistory(tid?: string) {
    setLoading(true);
    setError(null);
    try {
      const h = await api.history(visitorToken, tid);
      if (h.messages) {
        setMessages(h.messages.map(normalizeMessage));
        if (h.ticket_status) setTicketStatus(h.ticket_status);
      } else if (h.tickets && h.tickets.length > 0) {
        const recent: any = h.tickets[0];
        const rid = recent.ticket_id || recent.id;
        setTicketId(rid);
        const h2 = await api.history(visitorToken, rid);
        if (h2.messages) setMessages(h2.messages.map(normalizeMessage));
        if (h2.ticket_status) setTicketStatus(h2.ticket_status);
        else if (recent.status) setTicketStatus(recent.status);
      } else {
        setMessages([]);
        setTicketStatus(null);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }

  function startNewConversation() {
    setTicketId(null);
    setTicketStatus(null);
    setMessages([]);
    setError(null);
  }

  async function send(body: string) {
    setError(null);
    const localId = `local-${Date.now()}`;
    const localMsg: WidgetMessage = {
      message_id: localId,
      role: 'customer',
      body,
      created_at: new Date().toISOString(),
    };
    setMessages((m) => [...m, localMsg]);
    try {
      let realMessageId: string | undefined;
      if (ticketId && ticketStatus !== 'resolved') {
        const r = await api.followup(visitorToken, ticketId, body);
        realMessageId = r?.message_id;
      } else {
        const r = await api.ingest(visitorToken, body);
        setTicketId(r.ticket_id);
        setTicketStatus('open');
        realMessageId = r?.message_id;
      }
      // Replace the optimistic message_id with the real DB UUID so the WS echo
      // and any future history poll dedupe (which is keyed on message_id) will
      // recognise it and won't append the same bubble a second time.
      if (realMessageId) {
        setMessages((prev) =>
          prev.map((m) => (m.message_id === localId ? { ...m, message_id: realMessageId! } : m)),
        );
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to send');
    }
  }

  useEffect(() => {
    if (!open) return;
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // FE2: subscribe to the per-ticket WidgetTicketDO over WebSocket. Server
  // push replaces the prior 5s polling. The DO fans out frames written by
  // send-draft-reply (founder approvals) and auto-reply-worker (autonomous
  // replies). Optimistic `local-*` customer bubbles stay in place — incoming
  // frames dedupe by message_id.
  //
  // Fallback safety net: if the DO doesn't say hello within 15s (corporate
  // proxy strips WSS, sandboxed iframe blocks the upgrade), we start polling
  // widget-fetch-history every 5s. The poll stops the moment a real hello
  // frame arrives, so happy-path users only pay the 15s timer cost.
  useEffect(() => {
    if (!open || !ticketId) return;

    let helloReceived = false;
    let fallbackPoll: number | null = null;
    let fallbackTimer: number | null = null;

    function mergeFrame(raw: any) {
      const incoming = normalizeMessage(raw);
      if (!incoming.message_id) return;
      setMessages((prev) => {
        if (prev.some((m) => m.message_id === incoming.message_id)) return prev;
        return [...prev, incoming];
      });
    }

    function stopFallback() {
      if (fallbackPoll != null) { window.clearInterval(fallbackPoll); fallbackPoll = null; }
      if (fallbackTimer != null) { window.clearTimeout(fallbackTimer); fallbackTimer = null; }
    }

    fallbackTimer = window.setTimeout(() => {
      if (helloReceived) return;
      // WS upgrade didn't complete in time — start safety-net polling.
      fallbackPoll = window.setInterval(async () => {
        try {
          const h = await api.history(visitorToken, ticketId);
          (h.messages || []).forEach(mergeFrame);
        } catch { /* ignore transient errors */ }
      }, 5000);
    }, 15_000);

    const sub = openWidgetWs(
      appId,
      ticketId,
      visitorToken,
      mergeFrame,
      () => {
        helloReceived = true;
        // WS is live — kill any in-flight fallback machinery.
        stopFallback();
      },
    );

    return () => {
      stopFallback();
      sub.close();
    };
  }, [open, ticketId, appId, visitorToken, api]);

  const aiTyping = useMemo(() => {
    if (loading || ticketStatus === 'resolved') return false;
    const last = messages[messages.length - 1];
    return !!last && last.role === 'customer';
  }, [messages, loading, ticketStatus]);

  return (
    <div className="flex flex-col items-end gap-3">
      {open && (
        <WidgetPanel
          messages={messages}
          onSend={send}
          error={error}
          loading={loading}
          aiTyping={aiTyping}
          ticketStatus={ticketStatus}
          onStartNew={startNewConversation}
        />
      )}
      <LauncherButton open={open} onClick={() => setOpen((o) => !o)} />
    </div>
  );
}
