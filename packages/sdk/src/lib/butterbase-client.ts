import type { ButterbaseClientOptions, AuthChangeCallback, Subscription } from '../types/index.js';
import { AuthClient } from '../auth/auth-client.js';
import { StorageClient } from '../storage/storage-client.js';
import { FunctionsClient } from '../functions/functions-client.js';
import { SessionManager } from '../auth/session-manager.js';
import { detectSessionStorage, MemorySessionStorage } from '../auth/session-storage.js';
import { QueryBuilder } from './query-builder.js';
import { parseApiError, NetworkError } from '../errors/index.js';
import { AiClient } from '../ai/ai-client.js';
import { BillingClient } from '../billing/billing-client.js';
import { AdminClient } from '../admin/admin-client.js';
import { RealtimeClient } from '../realtime/realtime-client.js';
import { RagClient } from '../rag/rag-client.js';
import { IntegrationsClient } from '../integrations/integrations-client.js';
import { PartnersClient } from '../partners/partners-client.js';
import { PeopleClient } from '../people/people-client.js';

export class ButterbaseClient {
  public readonly appId: string;
  public readonly apiUrl: string;
  private anonKey?: string;
  private accessToken?: string;
  private options: ButterbaseClientOptions;

  public readonly sessionManager: SessionManager;
  public readonly auth: AuthClient;
  public readonly storage: StorageClient;
  public readonly functions: FunctionsClient;
  public readonly ai: AiClient;
  public readonly billing: BillingClient;
  public readonly admin: AdminClient;
  public readonly realtime: RealtimeClient;
  public readonly rag: RagClient;
  public readonly integrations: IntegrationsClient;
  public readonly partners: PartnersClient;
  public readonly people: PeopleClient;

  constructor(options: ButterbaseClientOptions) {
    this.appId = options.appId;
    this.apiUrl = options.apiUrl;
    this.anonKey = options.anonKey;
    this.options = options;

    // Initialize session manager with configured or auto-detected storage
    const persistSession = options.persistSession !== false;
    const storage = persistSession
      ? (options.sessionStorage ?? detectSessionStorage())
      : new MemorySessionStorage();
    this.sessionManager = new SessionManager(this.appId, storage);

    this.auth = new AuthClient(this);
    this.storage = new StorageClient(this);
    this.functions = new FunctionsClient(this);
    this.ai = new AiClient(this);
    this.billing = new BillingClient(this);
    this.admin = new AdminClient(this);
    this.realtime = new RealtimeClient(this);
    this.rag = new RagClient(this);
    this.integrations = new IntegrationsClient(this);
    this.partners = new PartnersClient(this);
    this.people = new PeopleClient(this);

    // Restore session from storage
    const restored = this.sessionManager.restoreSession();
    if (restored) {
      this.accessToken = restored.accessToken;
    }

    // Auto-detect OAuth tokens in the URL (browser only, opt-out with detectSessionFromUrl: false)
    if (options.detectSessionFromUrl !== false) {
      this.detectOAuthTokensFromUrl();
    }
  }

  /** Returns the current Authorization header value, or null if unauthenticated. */
  public getAuthHeader(): string | null {
    if (this.accessToken) return `Bearer ${this.accessToken}`;
    if (this.anonKey) return `Bearer ${this.anonKey}`;
    return null;
  }

  /**
   * If the current URL contains OAuth callback tokens, handle them automatically.
   * This fires-and-forgets — consumers who need the result should use auth.handleOAuthCallback() instead.
   */
  private detectOAuthTokensFromUrl(): void {
    if (typeof globalThis.window === 'undefined' || !globalThis.window.location) return;

    const params = new URLSearchParams(window.location.search);
    if (params.has('access_token') && params.has('refresh_token')) {
      // Kick off the callback handler; errors are surfaced via onAuthStateChange
      this.auth.handleOAuthCallback().catch(() => {
        // Swallow — apps that care should call handleOAuthCallback() explicitly
      });
    }
  }

  /**
   * Create a query builder for a table
   */
  from<T = any>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(table, this);
  }

  /**
   * Set the access token for authenticated requests
   */
  setAccessToken(token: string | undefined) {
    this.accessToken = token;
  }

  /**
   * Get the current access token
   */
  getAccessToken(): string | undefined {
    return this.accessToken;
  }

  /**
   * Subscribe to auth state changes
   */
  onAuthStateChange(callback: AuthChangeCallback): Subscription {
    return this.sessionManager.onAuthStateChange(callback);
  }

  /**
   * Ensure the access token is valid before making a request.
   * Auto-refreshes if expired/near-expiry.
   */
  private async ensureValidToken(): Promise<void> {
    // Only auto-refresh if there's a managed session (not a manually-set token)
    if (this.accessToken && this.sessionManager.getSession() && this.sessionManager.isAccessTokenExpired()) {
      const newSession = await this.sessionManager.refreshSession();
      if (newSession) {
        this.accessToken = newSession.accessToken;
      } else {
        this.accessToken = undefined;
      }
    }
  }

  /**
   * Internal request method used by all clients
   */
  async request<T>(
    method: string,
    path: string,
    body?: any,
    customHeaders?: Record<string, string>
  ): Promise<T> {
    // Auto-refresh before request (skip refresh endpoint to avoid loops)
    if (!path.endsWith('/refresh')) {
      await this.ensureValidToken();
    }

    const headers: Record<string, string> = {
      ...customHeaders,
    };

    // Only set Content-Type when sending a body to avoid Fastify's FST_ERR_CTP_EMPTY_JSON_BODY
    const serializedBody = body !== undefined && body !== null ? JSON.stringify(body) : undefined;
    if (serializedBody !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    // Auth priority: access token > anon key
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    } else if (this.anonKey) {
      headers['Authorization'] = `Bearer ${this.anonKey}`;
    }

    // All endpoints use apiUrl
    const url = `${this.apiUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers,
      body: serializedBody,
    });

    if (!response.ok) {
      // Call onUnauthorized callback for 401 responses
      if (response.status === 401 && this.options.onUnauthorized) {
        this.options.onUnauthorized();
      }

      let errorBody: any = {};
      try {
        errorBody = await response.json();
      } catch {
        errorBody = { error: response.statusText };
      }
      throw parseApiError(response.status, errorBody);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    // Parse JSON response
    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    return JSON.parse(text) as T;
  }

  /**
   * Internal request method for blob responses (e.g., file exports)
   */
  async requestBlob(
    method: string,
    path: string,
    body?: any,
    customHeaders?: Record<string, string>
  ): Promise<Blob> {
    // Auto-refresh before request (skip refresh endpoint to avoid loops)
    if (!path.endsWith('/refresh')) {
      await this.ensureValidToken();
    }

    const headers: Record<string, string> = {
      ...customHeaders,
    };

    // Auth priority: access token > anon key
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    } else if (this.anonKey) {
      headers['Authorization'] = `Bearer ${this.anonKey}`;
    }

    // All endpoints use apiUrl
    const url = `${this.apiUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      // Call onUnauthorized callback for 401 responses
      if (response.status === 401 && this.options.onUnauthorized) {
        this.options.onUnauthorized();
      }

      let errorBody: any = {};
      try {
        errorBody = await response.json();
      } catch {
        errorBody = { error: response.statusText };
      }
      throw parseApiError(response.status, errorBody);
    }

    return response.blob();
  }

  /**
   * Internal request method that returns the raw Response (for streaming).
   * Handles auth headers but does not parse the body.
   */
  async requestRaw(
    method: string,
    path: string,
    body?: any,
    customHeaders?: Record<string, string>
  ): Promise<Response> {
    if (!path.endsWith('/refresh')) {
      await this.ensureValidToken();
    }

    const headers: Record<string, string> = {
      ...customHeaders,
    };

    const serializedBody = body !== undefined && body !== null ? JSON.stringify(body) : undefined;
    if (serializedBody !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    } else if (this.anonKey) {
      headers['Authorization'] = `Bearer ${this.anonKey}`;
    }

    const url = `${this.apiUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers,
      body: serializedBody,
    });

    if (!response.ok) {
      if (response.status === 401 && this.options.onUnauthorized) {
        this.options.onUnauthorized();
      }

      let errorBody: any = {};
      try {
        errorBody = await response.json();
      } catch {
        errorBody = { error: response.statusText };
      }
      throw parseApiError(response.status, errorBody);
    }

    return response;
  }

  /**
   * Request an SSE / streaming body. Returns the underlying ReadableStream so the
   * caller can feed it to consumeSse() or similar.
   *
   * Throws a typed ButterbaseError on non-2xx (no chunks consumed).
   */
  async requestStream(
    method: string,
    path: string,
    body?: any,
    customHeaders?: Record<string, string>,
  ): Promise<ReadableStream<Uint8Array>> {
    const res = await this.requestRaw(method, path, body, {
      Accept: 'text/event-stream',
      ...(customHeaders ?? {}),
    });
    if (!res.body) {
      throw parseApiError(res.status, { error: { code: 'NETWORK_ERROR', message: 'response had no body' } });
    }
    return res.body;
  }
}

/**
 * Create a new Butterbase client instance
 */
export function createClient(options: ButterbaseClientOptions): ButterbaseClient {
  return new ButterbaseClient(options);
}
