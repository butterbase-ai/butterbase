export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface RealtimeChange {
  table: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
  timestamp: string;
}

export interface PresenceEvent {
  type: 'join' | 'update' | 'leave' | 'state';
  client_id?: string;
  user_id?: string | null;
  metadata?: Record<string, unknown>;
  clients?: Array<{ client_id: string; user_id: string | null; metadata: Record<string, unknown> }>;
}

export type ChangeCallback = (change: RealtimeChange) => void;
export type PresenceCallback = (event: PresenceEvent) => void;
export type StatusCallback = (status: RealtimeStatus) => void;

export interface RealtimeSubscription {
  unsubscribe: () => void;
}
