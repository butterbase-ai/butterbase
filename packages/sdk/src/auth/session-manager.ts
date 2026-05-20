import type { Session, LoginResponse } from '../types/index.js';
import type { SessionStorage } from './session-storage.js';

export type AuthEvent =
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'SESSION_RESTORED';

export type AuthChangeCallback = (
  event: AuthEvent,
  session: Session | null
) => void;

export interface Subscription {
  unsubscribe: () => void;
}

/** Refresh this many seconds before actual expiry */
const REFRESH_BUFFER_SECONDS = 60;

export class SessionManager {
  private session: Session | null = null;
  private storageKey: string;
  private storage: SessionStorage;
  private listeners: Set<AuthChangeCallback> = new Set();
  private refreshTimerId: ReturnType<typeof setTimeout> | null = null;
  private refreshPromise: Promise<Session | null> | null = null;

  /**
   * Injected by AuthClient so SessionManager doesn't depend on network logic.
   */
  private refreshFn:
    | ((refreshToken: string) => Promise<LoginResponse>)
    | null = null;

  constructor(appId: string, storage: SessionStorage) {
    this.storageKey = `butterbase.auth.${appId}`;
    this.storage = storage;
  }

  /**
   * AuthClient registers its refresh callback here during construction.
   */
  setRefreshFunction(
    fn: (refreshToken: string) => Promise<LoginResponse>
  ): void {
    this.refreshFn = fn;
  }

  /**
   * Restore session from storage. Called once during client init.
   */
  restoreSession(): Session | null {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;

      const stored: Session = JSON.parse(raw);
      if (!stored.accessToken || !stored.refreshToken) {
        this.storage.removeItem(this.storageKey);
        return null;
      }

      this.session = stored;
      this.scheduleRefresh();
      this.emit('SESSION_RESTORED', this.session);
      return this.session;
    } catch {
      this.storage.removeItem(this.storageKey);
      return null;
    }
  }

  /**
   * Save a new session from a LoginResponse.
   */
  setSessionFromLoginResponse(
    response: LoginResponse,
    event: AuthEvent = 'TOKEN_REFRESHED'
  ): Session {
    const session: Session = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + response.expires_in,
      user: response.user,
    };

    this.session = session;
    this.persist();
    this.scheduleRefresh();
    this.emit(event, session);
    return session;
  }

  /**
   * Get the current in-memory session.
   */
  getSession(): Session | null {
    return this.session;
  }

  /**
   * Clear session from memory and storage.
   */
  clearSession(): void {
    this.session = null;
    this.storage.removeItem(this.storageKey);
    this.cancelScheduledRefresh();
    this.emit('SIGNED_OUT', null);
  }

  /**
   * Returns true if the access token is expired or will expire
   * within REFRESH_BUFFER_SECONDS.
   */
  isAccessTokenExpired(): boolean {
    if (!this.session) return true;
    const now = Math.floor(Date.now() / 1000);
    return now >= this.session.expiresAt - REFRESH_BUFFER_SECONDS;
  }

  /**
   * Refresh the session. Deduplicates concurrent calls.
   */
  async refreshSession(): Promise<Session | null> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.doRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Subscribe to auth state changes.
   */
  onAuthStateChange(callback: AuthChangeCallback): Subscription {
    this.listeners.add(callback);
    return {
      unsubscribe: () => {
        this.listeners.delete(callback);
      },
    };
  }

  // ── Internal helpers ─────────────────────────────────────

  private async doRefresh(): Promise<Session | null> {
    if (!this.session?.refreshToken || !this.refreshFn) return null;

    try {
      const response = await this.refreshFn(this.session.refreshToken);
      const newSession = this.setSessionFromLoginResponse(
        response,
        'TOKEN_REFRESHED'
      );
      return newSession;
    } catch {
      this.clearSession();
      return null;
    }
  }

  private persist(): void {
    if (!this.session) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.session));
    } catch {
      // Storage full or unavailable — degrade silently
    }
  }

  private emit(event: AuthEvent, session: Session | null): void {
    for (const cb of this.listeners) {
      try {
        cb(event, session);
      } catch {
        // Don't let subscriber errors break the SDK
      }
    }
  }

  private scheduleRefresh(): void {
    this.cancelScheduledRefresh();
    if (!this.session) return;

    const now = Math.floor(Date.now() / 1000);
    const refreshAt = this.session.expiresAt - REFRESH_BUFFER_SECONDS;
    const delayMs = Math.max((refreshAt - now) * 1000, 0);

    this.refreshTimerId = setTimeout(() => {
      this.refreshSession();
    }, delayMs);
  }

  private cancelScheduledRefresh(): void {
    if (this.refreshTimerId !== null) {
      clearTimeout(this.refreshTimerId);
      this.refreshTimerId = null;
    }
  }
}
