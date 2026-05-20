import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type {
  RealtimeStatus, RealtimeChange, PresenceEvent,
  ChangeCallback, PresenceCallback, StatusCallback, RealtimeSubscription,
} from './types.js';

interface TableSubscription {
  filter: Record<string, unknown> | null;
  callbacks: Set<ChangeCallback>;
}

interface PendingEvent {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_RECONNECT_DELAY = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const HEARTBEAT_TIMEOUT = 45_000;
const EVENT_TIMEOUT = 30_000;

export class RealtimeClient {
  private client: ButterbaseClient;
  private ws: WebSocket | null = null;
  private status: RealtimeStatus = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  /** table → TableSubscription */
  private subscriptions = new Map<string, TableSubscription>();
  private presenceCallbacks = new Set<PresenceCallback>();
  private statusCallbacks = new Set<StatusCallback>();
  private pendingEvents = new Map<string, PendingEvent>();

  /** Presence metadata to re-track on reconnect */
  private trackedPresence: Record<string, unknown> | null = null;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  connect(): void {
    if (this.ws && (this.status === 'connected' || this.status === 'connecting')) return;
    this.doConnect();
  }

  disconnect(): void {
    this.clearTimers();
    this.reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // prevent auto-reconnect
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.setStatus('disconnected');
    this.reconnectAttempts = 0;
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  onStatus(callback: StatusCallback): RealtimeSubscription {
    this.statusCallbacks.add(callback);
    return { unsubscribe: () => { this.statusCallbacks.delete(callback); } };
  }

  // --------------------------------------------------------------------------
  // Table change subscriptions
  // --------------------------------------------------------------------------

  on(table: string, callbackOrFilter: ChangeCallback | Record<string, unknown>, maybeCallback?: ChangeCallback): RealtimeSubscription {
    let filter: Record<string, unknown> | null = null;
    let callback: ChangeCallback;

    if (typeof callbackOrFilter === 'function') {
      callback = callbackOrFilter;
    } else {
      filter = callbackOrFilter;
      callback = maybeCallback!;
    }

    const key = this.subKey(table, filter);
    let sub = this.subscriptions.get(key);

    if (!sub) {
      sub = { filter, callbacks: new Set() };
      this.subscriptions.set(key, sub);
      // Send subscribe if connected
      if (this.status === 'connected') {
        this.sendSubscribe(table, filter);
      } else {
        this.connect();
      }
    }

    sub.callbacks.add(callback);

    return {
      unsubscribe: () => {
        sub!.callbacks.delete(callback);
        if (sub!.callbacks.size === 0) {
          this.subscriptions.delete(key);
          if (this.status === 'connected') {
            this.sendJson({ type: 'unsubscribe', table });
          }
        }
      },
    };
  }

  // --------------------------------------------------------------------------
  // Presence
  // --------------------------------------------------------------------------

  trackPresence(metadata: Record<string, unknown>): void {
    this.trackedPresence = metadata;
    if (this.status === 'connected') {
      this.sendJson({ type: 'presence_track', metadata });
    } else {
      this.connect();
    }
  }

  updatePresence(metadata: Record<string, unknown>): void {
    this.trackedPresence = metadata;
    if (this.status === 'connected') {
      this.sendJson({ type: 'presence_update', metadata });
    }
  }

  onPresence(callback: PresenceCallback): RealtimeSubscription {
    this.presenceCallbacks.add(callback);
    return { unsubscribe: () => { this.presenceCallbacks.delete(callback); } };
  }

  // --------------------------------------------------------------------------
  // WebSocket triggers
  // --------------------------------------------------------------------------

  send(event: string, payload?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.status !== 'connected') {
        this.connect();
      }

      const timer = setTimeout(() => {
        this.pendingEvents.delete(event);
        reject(new Error(`Event "${event}" timed out after ${EVENT_TIMEOUT}ms`));
      }, EVENT_TIMEOUT);

      this.pendingEvents.set(event, { resolve, reject, timer });
      this.sendJson({ type: 'event', event, payload });
    });
  }

  // --------------------------------------------------------------------------
  // Internal: connection
  // --------------------------------------------------------------------------

  private doConnect(): void {
    this.setStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    const wsUrl = this.buildWsUrl();
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus('connected');
      this.resetHeartbeatTimer();
      this.replayState();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(typeof event.data === 'string' ? event.data : String(event.data));
    };

    this.ws.onclose = (event) => {
      this.ws = null;
      this.clearHeartbeatTimer();

      // Don't reconnect on intentional close
      if (event.code === 1000) {
        this.setStatus('disconnected');
        return;
      }

      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror — reconnect handled there
    };
  }

  private buildWsUrl(): string {
    const apiUrl = (this.client as any).apiUrl as string;
    const wsBase = apiUrl.replace(/^http/, 'ws');
    const token = this.client.getAccessToken() || (this.client as any).anonKey;
    const url = `${wsBase}/v1/${this.client.appId}/realtime`;
    return token ? `${url}?token=${encodeURIComponent(token)}` : url;
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setStatus('disconnected');
      this.rejectAllPending('Connection lost');
      return;
    }

    this.setStatus('reconnecting');
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), MAX_RECONNECT_DELAY);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  /** Re-subscribe to tables and re-track presence after reconnect */
  private replayState(): void {
    for (const [, sub] of this.subscriptions) {
      // Derive table name from the first callback's subscription
      // We need to iterate to find the table — stored in the key
    }
    // Iterate subscriptions by key to get table name
    for (const [key, sub] of this.subscriptions) {
      const table = key.split('\0')[0];
      this.sendSubscribe(table, sub.filter);
    }

    if (this.trackedPresence) {
      this.sendJson({ type: 'presence_track', metadata: this.trackedPresence });
    }
  }

  // --------------------------------------------------------------------------
  // Internal: message handling
  // --------------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    this.resetHeartbeatTimer();

    switch (msg.type) {
      case 'change':
        this.handleChange(msg as unknown as RealtimeChange);
        break;

      case 'presence_join':
        this.emitPresence({ type: 'join', client_id: msg.client_id as string, user_id: msg.user_id as string | null, metadata: msg.metadata as Record<string, unknown> });
        break;

      case 'presence_update':
        this.emitPresence({ type: 'update', client_id: msg.client_id as string, metadata: msg.metadata as Record<string, unknown> });
        break;

      case 'presence_leave':
        this.emitPresence({ type: 'leave', client_id: msg.client_id as string, user_id: msg.user_id as string | null });
        break;

      case 'presence_state':
        this.emitPresence({ type: 'state', clients: msg.clients as PresenceEvent['clients'] });
        break;

      case 'event_response': {
        const eventName = msg.event as string;
        const pending = this.pendingEvents.get(eventName);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingEvents.delete(eventName);
          pending.resolve(msg.data);
        }
        break;
      }

      case 'error': {
        // Check if this is an event error
        const errorMsg = msg.message as string;
        if (errorMsg?.startsWith('No handler for event:')) {
          const eventName = errorMsg.replace('No handler for event: ', '');
          const pending = this.pendingEvents.get(eventName);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingEvents.delete(eventName);
            pending.reject(new Error(errorMsg));
          }
        }
        break;
      }

      // 'connected', 'subscribed', 'unsubscribed', 'heartbeat' — no action needed
    }
  }

  private handleChange(change: RealtimeChange): void {
    for (const [key, sub] of this.subscriptions) {
      const table = key.split('\0')[0];
      if (table !== change.table) continue;

      for (const cb of sub.callbacks) {
        try { cb(change); } catch { /* don't let subscriber errors break the client */ }
      }
    }
  }

  private emitPresence(event: PresenceEvent): void {
    for (const cb of this.presenceCallbacks) {
      try { cb(event); } catch { /* ignore */ }
    }
  }

  // --------------------------------------------------------------------------
  // Internal: helpers
  // --------------------------------------------------------------------------

  private sendSubscribe(table: string, filter: Record<string, unknown> | null): void {
    const msg: Record<string, unknown> = { type: 'subscribe', table };
    if (filter) msg.filter = filter;
    this.sendJson(msg);
  }

  private sendJson(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private subKey(table: string, filter: Record<string, unknown> | null): string {
    if (!filter) return table + '\0';
    const sorted = Object.keys(filter).sort().map(k => `${k}=${filter[k]}`).join('&');
    return `${table}\0${sorted}`;
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const cb of this.statusCallbacks) {
      try { cb(status); } catch { /* ignore */ }
    }
  }

  private resetHeartbeatTimer(): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      // No heartbeat received — force reconnect
      if (this.ws) {
        this.ws.close(4000, 'Heartbeat timeout');
      }
    }, HEARTBEAT_TIMEOUT);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeatTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingEvents) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingEvents.clear();
  }
}
