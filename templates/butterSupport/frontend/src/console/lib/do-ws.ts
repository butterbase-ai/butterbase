import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { bb, SUBDOMAIN, getAccessToken } from './bb';

export type DoServerEvent =
  | { type: 'hello'; ticket_id: string; session_id: string; agent_state: string }
  | { type: 'state'; agent_state: string }
  | { type: 'agent_message'; role: 'assistant'; content: string; tool_calls?: any }
  | { type: 'tool_call_start'; tool: string; args: any }
  | { type: 'tool_call_result'; tool: string; result: any }
  | { type: 'diagnosis'; diagnosis: any }
  | { type: 'draft_proposed'; message: any; confidence?: string }
  | { type: 'followup_question_proposed'; message: any }
  | { type: 'escalation'; reason: string; urgency?: string; substrate_action_id?: string }
  | { type: 'error'; reason: string; message?: string; current_driver?: string }
  | { type: 'heartbeat_ack' };

export type DoClientCommand =
  | { cmd: 'diagnose'; hint?: string }
  | { cmd: 'draft'; hint?: string }
  | { cmd: 'rerun_with_hint'; hint: string }
  | { cmd: 'escalate'; reason: string }
  | { cmd: 'heartbeat' };

export interface DoState {
  state: string;
  events: DoServerEvent[];
  connected: boolean;
  readonly: boolean;
  readonlyReason?: string;
}

export function useTicketDoWs(ticketId: string | undefined) {
  const [state, setState] = useState<DoState>({
    state: 'idle',
    events: [],
    connected: false,
    readonly: false,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<number | null>(null);

  useEffect(() => {
    if (!ticketId) return;
    let cancelled = false;

    (async () => {
      const token = await getAccessToken();
      if (!token) {
        setState((s) => ({ ...s, readonly: true, readonlyReason: 'not_authenticated' }));
        return;
      }
      // DO routes are subdomain-only (api.butterbase.ai/v1/{app_id}/_do/... returns
      // 404). Cloudflare's WS dispatcher rejects ?token= when Origin is cross-origin
      // (CSRF defense) — and browsers always send Origin + can't set Authorization
      // on WS handshakes. The browser-safe channel is Sec-WebSocket-Protocol, which
      // we pass via the WebSocket constructor's protocols arg. The DO unpacks the
      // `bearer.<jwt>` subprotocol and echoes it on the 101 response (browser
      // requirement). See LR9 in docs/butterbase/06-v1-deferred.md.
      const url = `wss://${SUBDOMAIN}.butterbase.dev/_do/support-ticket-do/${ticketId}`;
      const ws = new WebSocket(url, [`bearer.${token}`]);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setState((s) => ({ ...s, connected: true }));
        heartbeatRef.current = window.setInterval(() => {
          try {
            ws.send(JSON.stringify({ cmd: 'heartbeat' }));
          } catch {
            // ignore
          }
        }, 30000);
      };

      ws.onmessage = (ev) => {
        // Suppress messages from a socket that's been superseded by a re-mount
        // (React StrictMode double-invokes effects in dev). Without this guard
        // we get duplicate `hello` frames and the events array doubles up.
        if (cancelled) return;
        let msg: DoServerEvent | null = null;
        try {
          msg = JSON.parse(ev.data) as DoServerEvent;
        } catch {
          return;
        }
        if (!msg) return;
        setState((s) => {
          const next: DoState = { ...s, events: [...s.events, msg!] };
          if (msg!.type === 'hello' || msg!.type === 'state') {
            next.state = (msg as any).agent_state;
          }
          if (msg!.type === 'error' && (msg as any).reason === 'driven_by_other_user') {
            next.readonly = true;
            next.readonlyReason = 'driven_by_other_user';
          }
          return next;
        });
      };

      ws.onerror = () => {
        if (cancelled) return;
        setState((s) => ({ ...s, connected: false }));
      };

      ws.onclose = () => {
        if (cancelled) return;
        setState((s) => ({ ...s, connected: false }));
        if (heartbeatRef.current) {
          window.clearInterval(heartbeatRef.current);
          heartbeatRef.current = null;
        }
      };
    })();

    return () => {
      cancelled = true;
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    };
  }, [ticketId]);

  function send(cmd: DoClientCommand) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(cmd));
  }

  return { ...state, send };
}

// Replay persisted agent activity from the DB so the trace survives refreshes
// and is visible to teammates who weren't watching the live stream. Reads
// agent_messages rows for this ticket's thread and reconstructs the same
// DoServerEvent shapes the LiveAgentStream already renders. Caller merges
// these with the live WS events.
export function useReplayedAgentEvents(ticketId: string | undefined): DoServerEvent[] {
  const { data: threads = [] } = useQuery({
    queryKey: ['agent_threads_for_replay', ticketId],
    queryFn: async () => {
      if (!ticketId) return [];
      const res: any = await bb.from('agent_threads').select('id').eq('ticket_id', ticketId);
      return (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []) as { id: string }[];
    },
    enabled: !!ticketId,
  });
  const threadIds = useMemo(() => threads.map((t) => t.id), [threads]);

  const { data: messages = [] } = useQuery({
    queryKey: ['agent_messages_for_replay', ticketId, threadIds.join(',')],
    queryFn: async () => {
      if (threadIds.length === 0) return [];
      const res: any = await bb
        .from('agent_messages')
        .select('id,thread_id,role,content,tool_calls,tool_results,token_usage,created_at')
        .in('thread_id', threadIds)
        .order('created_at', { ascending: true });
      return (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []) as any[];
    },
    enabled: threadIds.length > 0,
  });

  return useMemo(() => {
    if (!messages.length) return [];
    const events: DoServerEvent[] = [];
    for (const m of messages) {
      // agent_message — the assistant's content (possibly empty when only tools)
      if (m.role === 'assistant' || m.role === 'agent') {
        events.push({ type: 'agent_message', role: 'assistant', content: m.content || '', tool_calls: m.tool_calls?.items ?? null });
      }
      // tool_call_start + tool_call_result per call. tool_calls and tool_results
      // are stored as { items: [...] } (LR7 JSONB-array wrap).
      const calls: any[] = Array.isArray(m.tool_calls?.items) ? m.tool_calls.items : [];
      const results: any[] = Array.isArray(m.tool_results?.items) ? m.tool_results.items : [];
      const resultByCallId = new Map<string, any>();
      for (const r of results) if (r?.tool_call_id) resultByCallId.set(r.tool_call_id, r);
      for (const tc of calls) {
        const name = tc?.function?.name || tc?.name || 'unknown';
        let args: any = {};
        try { args = typeof tc?.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc?.function?.arguments || {}); } catch { /* keep {} */ }
        events.push({ type: 'tool_call_start', tool: name, args });
        const matched = resultByCallId.get(tc?.id);
        if (matched) {
          events.push({ type: 'tool_call_result', tool: name, result: matched.result ?? matched });
        }
      }
    }
    return events;
  }, [messages]);
}
