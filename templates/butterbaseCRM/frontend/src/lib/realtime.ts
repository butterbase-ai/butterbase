import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { bb } from './butterbase';
import { qk } from './queryKeys';
import { useWorkspaceStore } from './workspace';

// NOTE: `meetings` has been migrated to substrate (per-user memory, type='event' entities) and the
// Postgres `meetings` table is being dropped. Do not re-add it here — the CDC subscription would
// fail or fire on a table that no longer exists.
//
// TODO(substrate): subscribe to /v1/me/substrate/stream for type=event entity changes so that
// meeting (and other substrate-backed) React Query caches get push-invalidated instead of relying
// on staleTime/refetch. Pattern:
//   1. POST /v1/me/substrate/ws-ticket via a new `ws_ticket` op on the substrate-proxy function
//      (the browser doesn't hold the substrate API key directly, so it must go through the proxy).
//   2. Open wss://api.butterbase.ai/v1/me/substrate/stream?ticket=<ticket>.
//   3. On frames {tbl:'entities', op:'insert'|'update'|'delete'}, refetch by id and invalidate
//      qk.meetings(wsId), ['meetings', wsId, 'byEntity'], ['meeting_substrate_attendees'], plus
//      companies/people keys (which also read from substrate now).
//   4. Mirror the CDC reconnect/backoff behavior (bb.realtime.connect() handles that today; the
//      substrate stream will need its own loop with the same shape).
// Left as a follow-up because it requires extending backend/functions/substrate-proxy/handler.ts
// with a new `ws_ticket` op, which is out of scope for this commit. Until then, substrate-backed
// reads accept a real-but-tolerable UX regression: they refresh on staleTime / window focus rather
// than via push.
// `companies` and `people` are no longer Postgres tables — they live in substrate.
// `deals` has been migrated too. CDC subscriptions for them would fail at the
// server. The substrate stream subscription described above is the
// replacement plan; until that lands these queries refresh on staleTime/focus.
const tablesToWatch = ['notes', 'activities', 'attachments', 'social_posts', 'social_post_sends', 'social_comments'] as const;

// Set localStorage.setItem('bb:rt-debug', '1') in devtools to see every CDC frame + connection
// state change logged. Used to trace the "social status stuck on 'sending' until refresh" bug.
function debugEnabled(): boolean {
  try { return localStorage.getItem('bb:rt-debug') === '1'; } catch { return false; }
}

/** True once bb has a hydrated session; flips with auth state changes. Gate realtime.connect() on this — the WS server closes unauth'd connections instantly, which surfaces as a noisy "WebSocket failed:" in the console. */
export function useHasBbSession(): boolean {
  const [ready, setReady] = useState(() => !!(bb as any).sessionManager?.getSession?.());
  useEffect(() => {
    const sub = bb.onAuthStateChange((_e, session) => setReady(!!session));
    return () => sub.unsubscribe();
  }, []);
  return ready;
}

export function useRealtimeInvalidation() {
  const qc = useQueryClient();
  const wsId = useWorkspaceStore((s) => s.workspaceId);
  const hasSession = useHasBbSession();

  useEffect(() => {
    if (!wsId || !hasSession) return;
    const debug = debugEnabled();
    if (debug) {
      // eslint-disable-next-line no-console
      console.log('[rt] connect', { wsId, tables: tablesToWatch });
    }
    bb.realtime.connect();

    let statusSub: { unsubscribe: () => void } | null = null;
    if (debug && typeof (bb.realtime as any).onStatus === 'function') {
      statusSub = (bb.realtime as any).onStatus((status: string) => {
        // eslint-disable-next-line no-console
        console.log('[rt] status', status);
      });
    }

    const subs = tablesToWatch.map((table) =>
      bb.realtime.on(table, (change: any) => {
        if (debug) {
          // eslint-disable-next-line no-console
          console.log('[rt] frame', {
            table,
            op: change?.op,
            id: change?.record?.id ?? change?.old_record?.id ?? null,
            status: change?.record?.status ?? null,
            ts: change?.timestamp ?? null,
          });
        }
        switch (table) {
          case 'notes':
            qc.invalidateQueries({ queryKey: ['notes'] });
            break;
          case 'activities':
            qc.invalidateQueries({ queryKey: qk.activities(wsId) });
            break;
          case 'attachments':
            qc.invalidateQueries({ queryKey: ['attachments'] });
            break;
          case 'social_posts':
          case 'social_post_sends':
            qc.invalidateQueries({ queryKey: ['social-posts'] });
            break;
          case 'social_comments':
            qc.invalidateQueries({ queryKey: ['social-comments'] });
            break;
        }
      }),
    );
    return () => {
      for (const s of subs) s.unsubscribe();
      statusSub?.unsubscribe();
    };
  }, [wsId, qc, hasSession]);
}
