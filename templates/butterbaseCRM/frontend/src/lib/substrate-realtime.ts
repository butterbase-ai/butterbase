// Subscribe to the per-user substrate WS stream and invalidate TanStack Query
// keys on entity/action_ledger changes. The stream emits envelope-only frames
// — {tbl, op, id, user} — so we refetch by id rather than patching in place.
//
// Auth path: browser → substrate-ws-ticket (function) → POST /v1/me/substrate/ws-ticket
// (with ctx.substrate token) → 60s ticket → WS upgrade with ?ticket=…
//
// NB: this is additive. Until Phase 2 drops the mirror tables, the existing
// per-table realtime in realtime.ts also invalidates the same cache keys.

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { bbInvoke } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';

interface SubstrateFrame {
  tbl: 'entity' | 'action_ledger' | 'attention_rule' | 'rule_firing' | string;
  op: 'insert' | 'update' | 'delete';
  id: string;
  user: string;
}

const API_BASE = (import.meta.env.VITE_BUTTERBASE_API_BASE as string | undefined)
  ?? 'https://api.butterbase.ai';

async function mintTicket(): Promise<string | null> {
  const { data, error } = await bbInvoke<{ ticket?: string }>('substrate-proxy', { op: 'ws_ticket' });
  if (error || !data?.ticket) return null;
  return data.ticket;
}

export function useSubstrateRealtime() {
  const qc = useQueryClient();
  const ws = useCurrentWorkspaceId();

  useEffect(() => {
    let ws_: WebSocket | null = null;
    let stopped = false;
    let backoffMs = 1000;

    async function connect() {
      if (stopped) return;
      const ticket = await mintTicket();
      if (!ticket || stopped) return;
      const url = `${API_BASE.replace(/^http/, 'ws')}/v1/me/substrate/stream?ticket=${encodeURIComponent(ticket)}`;
      ws_ = new WebSocket(url);

      ws_.onmessage = (e) => {
        let frame: SubstrateFrame | { type: string };
        try { frame = JSON.parse(e.data); } catch { return; }
        if ((frame as any).type === 'hello') return;
        const f = frame as SubstrateFrame;

        if (f.tbl === 'entity') {
          // Invalidate the per-id query and all type-bucket lists. We can't
          // tell which type without a refetch, so invalidate the union.
          qc.invalidateQueries({ queryKey: qk.company(f.id) });
          qc.invalidateQueries({ queryKey: qk.companies(ws) });
          qc.invalidateQueries({ queryKey: qk.people(ws) });
          qc.invalidateQueries({ queryKey: qk.deals(ws) });
          qc.invalidateQueries({ queryKey: qk.meetings(ws) });
        } else if (f.tbl === 'action_ledger') {
          // Activity feed + notes (both live in the ledger post-migration).
          qc.invalidateQueries({ queryKey: qk.activities(ws) });
          qc.invalidateQueries({ queryKey: ['notes'] });
        }
      };

      ws_.onclose = () => {
        if (stopped) return;
        // Reconnect with backoff.
        setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      };

      ws_.onopen = () => { backoffMs = 1000; };
      ws_.onerror = () => { /* close handler runs next */ };
    }

    connect();
    return () => {
      stopped = true;
      ws_?.close();
    };
  }, [qc, ws]);
}
