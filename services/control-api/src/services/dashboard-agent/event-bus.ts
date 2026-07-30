/**
 * In-memory per-conversation event bus for the dashboard assistant.
 *
 * The message route hijacks its response and streams LoopEvents inline for
 * the caller who submitted the turn. This bus is a SECOND publish channel:
 * anyone else subscribed to the conversation (another tab, the same tab
 * after refresh, a background reader) also sees every event live via the
 * `/conversations/:id/stream` SSE endpoint.
 *
 * Scope guard (Plan 4 fixes): single-node only. In a multi-instance deploy
 * a subscriber only sees events published from the same process that runs
 * the loop. Replace with Redis pub/sub before scaling out.
 */
import type { LoopEvent } from './loop.js';

type Listener = (event: LoopEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function publish(conversationId: string, event: LoopEvent): void {
  const set = listeners.get(conversationId);
  if (!set) return;
  for (const l of set) {
    try { l(event); } catch { /* subscriber errors must not break the loop */ }
  }
}

export function subscribe(conversationId: string, listener: Listener): () => void {
  let set = listeners.get(conversationId);
  if (!set) {
    set = new Set();
    listeners.set(conversationId, set);
  }
  set.add(listener);
  return () => {
    const s = listeners.get(conversationId);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) listeners.delete(conversationId);
  };
}

export function subscriberCount(conversationId: string): number {
  return listeners.get(conversationId)?.size ?? 0;
}
