// platform-event-bus.ts
import type { Pool } from 'pg';

export type PlatformEventMap = {
  'auth.signup.completed': {
    appId: string;
    userId: string;
    email: string;
    displayName: string | null;
    provider: string;
    runtimeDb: Pool;
  };
  'auth.email.verified': {
    appId: string;
    userId: string;
    email: string;
    runtimeDb: Pool;
  };
  'auth.user.deleted': {
    appId: string;
    userId: string;
    email: string;
    runtimeDb: Pool;
  };
};

type Handler<E extends keyof PlatformEventMap> = (p: PlatformEventMap[E]) => Promise<void> | void;

interface BusLogger {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface PlatformEventBus {
  emit<E extends keyof PlatformEventMap>(event: E, payload: PlatformEventMap[E]): void;
  subscribe<E extends keyof PlatformEventMap>(event: E, handler: Handler<E>): () => void;
}

export function createPlatformEventBus(opts: { logger: BusLogger }): PlatformEventBus {
  const handlers = new Map<keyof PlatformEventMap, Set<Handler<any>>>();

  return {
    subscribe(event, handler) {
      let set = handlers.get(event);
      if (!set) { set = new Set(); handlers.set(event, set); }
      set.add(handler);
      return () => set!.delete(handler);
    },
    emit(event, payload) {
      const set = handlers.get(event);
      if (!set) return;
      // Fire-and-forget; isolate each handler's failure.
      for (const h of set) {
        Promise.resolve()
          .then(() => h(payload))
          .catch(err => opts.logger.warn({ err, event }, 'platform event handler failed'));
      }
    },
  };
}
