import pg from 'pg';
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { config } from '../config.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { getAppPoolForApp } from './app-pool.js';
import { getRedisPubClient, getRedisSubClient, onRedisMessage, getRedisClient } from './redis.js';
import { getLimitsForApp } from './app-plan-resolver.js';

// ============================================================================
// Types
// ============================================================================

interface SubscriptionFilter {
  [column: string]: unknown;
}

interface WsClient {
  socket: WebSocket;
  appId: string;
  userId: string | null;
  role: 'butterbase_anon' | 'butterbase_user' | 'butterbase_service';
  /** table name → filter (null = no filter, receive all changes) */
  subscribedTables: Map<string, SubscriptionFilter | null>;
  /** Unique client ID for presence tracking */
  clientId: string;
  /** Presence metadata (null = not tracking presence) */
  presenceMetadata: Record<string, unknown> | null;
}

interface AppListener {
  appId: string;
  dbName: string;
  client: pg.Client | null;
  subscribers: Set<WsClient>;
  connected: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  teardownTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  /** Direct connection string for Neon apps, null for local */
  connectionString: string | null;
}

interface ChangeRecord {
  id: string;
  table_name: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
  created_at: string;
}

export interface RealtimeLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// ============================================================================
// RealtimeManager
// ============================================================================

export class RealtimeManager {
  private listeners = new Map<string, AppListener>();
  private clientMap = new Map<WebSocket, WsClient>();
  private controlDb: pg.Pool;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private presenceRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private log: RealtimeLogger;
  private instanceId = crypto.randomUUID();
  // Presence TTL for the Redis listener registry. Refreshed before it
  // expires; if an instance crashes, its entries fall off automatically.
  private static readonly PRESENCE_TTL_SEC = 60;
  private static readonly PRESENCE_REFRESH_MS = 25_000;
  private static readonly PRESENCE_KEY_PREFIX = 'realtime:listeners:';

  constructor(controlDb: pg.Pool, logger?: RealtimeLogger) {
    this.controlDb = controlDb;
    this.log = logger ?? console;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  start(): void {
    // Heartbeat timer
    this.heartbeatInterval = setInterval(() => {
      const now = new Date().toISOString();
      for (const wsClient of this.clientMap.values()) {
        this.send(wsClient.socket, { type: 'heartbeat', timestamp: now });
      }
    }, config.realtime.heartbeatIntervalMs);

    // Cleanup timer for old change records
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldChanges().catch((err) => {
        this.log.error({ err }, '[Realtime] Failed to cleanup old changes');
      });
    }, config.realtime.cleanupIntervalMs);

    // Refresh Redis listener-presence entries before they TTL out. We
    // can't infer presence from PUBSUB NUMSUB on multi-node Redis (e.g.
    // Upstash splits pub/sub routing from command routing, so NUMSUB
    // returns 0 even when fanout works fine), so each instance writes
    // an explicit per-app key it keeps alive while it holds a listener.
    this.presenceRefreshInterval = setInterval(() => {
      this.refreshPresence().catch((err) => {
        this.log.warn({ err }, '[Realtime] presence refresh failed');
      });
    }, RealtimeManager.PRESENCE_REFRESH_MS);

    // Cross-instance realtime via Redis pub/sub
    onRedisMessage((channel, message) => {
      if (channel.startsWith('realtime:changes:')) {
        const appId = channel.slice('realtime:changes:'.length);
        this.handleRedisChange(appId, message).catch((err) => {
          this.log.error({ err, appId }, '[Realtime] Failed to handle Redis change');
        });
      } else if (channel.startsWith('realtime:presence:')) {
        const appId = channel.slice('realtime:presence:'.length);
        this.handleRedisPresence(appId, message);
      }
    });
  }

  async shutdown(): Promise<void> {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.presenceRefreshInterval) clearInterval(this.presenceRefreshInterval);

    // Drop our presence entries so the cluster sees we're gone immediately.
    const presenceCleanup: Promise<unknown>[] = [];
    for (const appId of this.listeners.keys()) {
      presenceCleanup.push(this.removePresence(appId).catch(() => {}));
    }

    // Close all WebSocket clients
    for (const wsClient of this.clientMap.values()) {
      this.send(wsClient.socket, { type: 'error', message: 'Server shutting down' });
      wsClient.socket.close(1001, 'Server shutting down');
    }
    this.clientMap.clear();

    // Close all LISTEN connections
    const closePromises: Promise<void>[] = [];
    const sub = getRedisSubClient();
    for (const appId of this.listeners.keys()) {
      sub.unsubscribe(`realtime:changes:${appId}`, `realtime:presence:${appId}`).catch(() => {});
    }
    for (const listener of this.listeners.values()) {
      if (listener.reconnectTimer) clearTimeout(listener.reconnectTimer);
      if (listener.teardownTimer) clearTimeout(listener.teardownTimer);
      if (listener.client) {
        closePromises.push(
          listener.client.end().catch(() => {})
        );
      }
    }
    this.listeners.clear();
    await Promise.all([...closePromises, ...presenceCleanup]);
  }

  // --------------------------------------------------------------------------
  // Presence registry — explicit per-app per-instance Redis keys, so
  // /realtime/config can answer "is any instance holding a listener?"
  // without depending on PUBSUB NUMSUB (unreliable on Upstash).
  // --------------------------------------------------------------------------

  private presenceKey(appId: string): string {
    return `${RealtimeManager.PRESENCE_KEY_PREFIX}${appId}:${this.instanceId}`;
  }

  private async writePresence(appId: string): Promise<void> {
    try {
      await getRedisClient().set(
        this.presenceKey(appId),
        '1',
        'EX',
        RealtimeManager.PRESENCE_TTL_SEC,
      );
    } catch (err) {
      this.log.warn({ err, appId }, '[Realtime] writePresence failed');
    }
  }

  private async removePresence(appId: string): Promise<void> {
    try {
      await getRedisClient().del(this.presenceKey(appId));
    } catch (err) {
      this.log.warn({ err, appId }, '[Realtime] removePresence failed');
    }
  }

  private async refreshPresence(): Promise<void> {
    if (this.listeners.size === 0) return;
    const client = getRedisClient();
    await Promise.allSettled(
      Array.from(this.listeners.keys()).map((appId) =>
        client.set(this.presenceKey(appId), '1', 'EX', RealtimeManager.PRESENCE_TTL_SEC),
      ),
    );
  }

  /** Cluster-wide check: does any instance currently hold a listener for this app? */
  async hasActiveListener(appId: string): Promise<boolean> {
    if (this.listeners.has(appId)) return true; // local fast path
    try {
      const client = getRedisClient();
      const pattern = `${RealtimeManager.PRESENCE_KEY_PREFIX}${appId}:*`;
      // SCAN avoids the O(N)-keyspace cost of KEYS. We bail on the first hit.
      let cursor = '0';
      do {
        const [next, batch] = (await client.scan(cursor, 'MATCH', pattern, 'COUNT', 50)) as [string, string[]];
        if (batch.length > 0) return true;
        cursor = next;
      } while (cursor !== '0');
      return false;
    } catch (err) {
      this.log.warn({ err, appId }, '[Realtime] hasActiveListener fallback to local stat');
      return this.listeners.has(appId);
    }
  }

  // --------------------------------------------------------------------------
  // Client management
  // --------------------------------------------------------------------------

  async addClient(
    socket: WebSocket,
    appId: string,
    dbName: string,
    userId: string | null,
    role: 'butterbase_anon' | 'butterbase_user' | 'butterbase_service'
  ): Promise<void> {
    const clientId = crypto.randomUUID();
    const wsClient: WsClient = { socket, appId, userId, role, subscribedTables: new Map(), clientId, presenceMetadata: null };
    this.clientMap.set(socket, wsClient);

    // Per-app subscriber cap driven by the app-owner's plan tier.
    const limits = await getLimitsForApp(this.controlDb, appId).catch(() => null);
    const perAppCap = limits?.maxRealtimeListenersPerApp ?? -1;

    // Ensure a LISTEN connection exists for this app
    let listener = this.listeners.get(appId);
    if (listener) {
      if (perAppCap !== -1 && listener.subscribers.size >= perAppCap) {
        this.send(socket, {
          type: 'error',
          message: `Realtime listener limit reached for this app (${perAppCap}). Upgrade your plan for more.`,
        });
        socket.close(1013, 'Per-app realtime listener limit reached');
        this.clientMap.delete(socket);
        return;
      }
      // Cancel any pending teardown
      if (listener.teardownTimer) {
        clearTimeout(listener.teardownTimer);
        listener.teardownTimer = null;
      }
      listener.subscribers.add(wsClient);
    } else {
      // Global channel-count backstop (protects the process, not per-app fairness).
      if (this.listeners.size >= config.realtime.maxListenConnections) {
        this.send(socket, {
          type: 'error',
          message: 'Realtime connection limit reached. Try again later.',
        });
        socket.close(1013, 'Connection limit reached');
        this.clientMap.delete(socket);
        return;
      }

      // The per-app cap also applies when this is the first subscriber —
      // 0 >= cap only when cap is 0 (effectively disabled tier).
      if (perAppCap === 0) {
        this.send(socket, {
          type: 'error',
          message: 'Realtime is not available on this plan.',
        });
        socket.close(1013, 'Realtime disabled by plan');
        this.clientMap.delete(socket);
        return;
      }

      // Resolve connection string for Neon apps — app_db_connections lives
      // in the app's home region's runtime DB.
      let connectionString: string | null = null;
      try {
        const runtimePool = await getRuntimeDbForApp(this.controlDb, appId);
        const connRow = await runtimePool.query<{ connection_string: string }>(
          'SELECT connection_string FROM app_db_connections WHERE app_id = $1',
          [appId]
        );
        if (connRow.rows.length > 0) {
          connectionString = connRow.rows[0].connection_string;
        }
      } catch {
        // Fall through to local connection
      }

      listener = {
        appId,
        dbName,
        client: null,
        subscribers: new Set([wsClient]),
        connected: false,
        reconnectTimer: null,
        teardownTimer: null,
        reconnectAttempts: 0,
        connectionString,
      };
      this.listeners.set(appId, listener);
      await this.connectListener(listener);

      const sub = getRedisSubClient();
      await sub.subscribe(`realtime:changes:${appId}`, `realtime:presence:${appId}`);

      // Announce presence so other instances answer hasActiveListener() truthfully.
      await this.writePresence(appId);
    }
  }

  removeClient(socket: WebSocket): void {
    const wsClient = this.clientMap.get(socket);
    if (!wsClient) return;

    // Broadcast presence_leave if this client was tracking presence
    if (wsClient.presenceMetadata !== null) {
      const listener = this.listeners.get(wsClient.appId);
      if (listener) {
        for (const other of listener.subscribers) {
          if (other.socket !== socket && other.presenceMetadata !== null) {
            this.send(other.socket, {
              type: 'presence_leave',
              client_id: wsClient.clientId,
              user_id: wsClient.userId,
            });
          }
        }

        getRedisPubClient().publish(
          `realtime:presence:${wsClient.appId}`,
          JSON.stringify({
            type: 'leave',
            clientId: wsClient.clientId,
            userId: wsClient.userId,
            sourceInstance: this.instanceId,
          }),
        ).catch(() => {});
      }
    }

    this.clientMap.delete(socket);

    const listener = this.listeners.get(wsClient.appId);
    if (!listener) return;

    listener.subscribers.delete(wsClient);

    // If no more subscribers, schedule teardown
    if (listener.subscribers.size === 0 && !listener.teardownTimer) {
      listener.teardownTimer = setTimeout(() => {
        this.teardownListener(wsClient.appId);
      }, config.realtime.teardownGraceMs);
    }
  }

  // --------------------------------------------------------------------------
  // Subscriptions
  // --------------------------------------------------------------------------

  subscribe(socket: WebSocket, table: string, filter?: SubscriptionFilter | null): void {
    const wsClient = this.clientMap.get(socket);
    if (!wsClient) return;

    wsClient.subscribedTables.set(table, filter ?? null);
    this.send(socket, { type: 'subscribed', table, ...(filter ? { filter } : {}) });

    // Best-effort warning when the table has no realtime trigger installed.
    // Without the trigger, INSERTs never write to realtime.changes, so the
    // subscriber would sit silent forever — confusing during testing.
    // Fire-and-forget; failure to check is not worth blocking the ACK.
    this.warnIfTableNotWatched(socket, wsClient.appId, table).catch((err) => {
      this.log.warn({ err, appId: wsClient.appId, table }, '[Realtime] watched_tables check failed');
    });
  }

  private async warnIfTableNotWatched(
    socket: WebSocket,
    appId: string,
    table: string,
  ): Promise<void> {
    let pool;
    try {
      // `apps` lives in the app's home region's runtime DB
      const runtimePool = await getRuntimeDbForApp(this.controlDb, appId);
      const appRow = await runtimePool.query(
        'SELECT db_name FROM apps WHERE id = $1',
        [appId],
      );
      const dbName = appRow.rows[0]?.db_name;
      if (!dbName) return;
      pool = await getAppPoolForApp(this.controlDb, appId, dbName);
    } catch {
      return; // can't check, skip
    }

    let watched = false;
    try {
      const r = await pool.query(
        'SELECT 1 FROM realtime.watched_tables WHERE table_name = $1 LIMIT 1',
        [table],
      );
      watched = r.rowCount !== null && r.rowCount > 0;
    } catch {
      // Schema/table may not exist on very old apps — treat as inconclusive,
      // don't warn (avoid false positives).
      return;
    }

    if (!watched) {
      this.send(socket, {
        type: 'warning',
        code: 'TABLE_NOT_REALTIME_ENABLED',
        table,
        message:
          `Subscribed to "${table}", but realtime is not enabled on this table — ` +
          `no change events will be delivered until you enable it.`,
        remediation:
          `Enable it in the dashboard (Realtime page → "Enable table") or ` +
          `POST /v1/${appId}/realtime/configure with {"tables":["${table}"]}.`,
      });
    }
  }

  unsubscribe(socket: WebSocket, table: string): void {
    const wsClient = this.clientMap.get(socket);
    if (!wsClient) return;

    wsClient.subscribedTables.delete(table);
    this.send(socket, { type: 'unsubscribed', table });
  }

  // --------------------------------------------------------------------------
  // Presence
  // --------------------------------------------------------------------------

  trackPresence(socket: WebSocket, metadata: Record<string, unknown>): void {
    const wsClient = this.clientMap.get(socket);
    if (!wsClient) return;

    wsClient.presenceMetadata = metadata;

    const listener = this.listeners.get(wsClient.appId);
    if (!listener) return;

    // Send current presence state to the new tracker
    const currentClients: Array<{ client_id: string; user_id: string | null; metadata: Record<string, unknown> }> = [];
    for (const other of listener.subscribers) {
      if (other.presenceMetadata !== null && other.socket !== socket) {
        currentClients.push({
          client_id: other.clientId,
          user_id: other.userId,
          metadata: other.presenceMetadata,
        });
      }
    }
    this.send(socket, { type: 'presence_state', clients: currentClients });

    // Broadcast presence_join to all other presence-tracking clients
    for (const other of listener.subscribers) {
      if (other.socket !== socket && other.presenceMetadata !== null) {
        this.send(other.socket, {
          type: 'presence_join',
          client_id: wsClient.clientId,
          user_id: wsClient.userId,
          metadata,
        });
      }
    }

    // Publish join to all instances via Redis
    getRedisPubClient().publish(
      `realtime:presence:${wsClient.appId}`,
      JSON.stringify({
        type: 'join',
        clientId: wsClient.clientId,
        userId: wsClient.userId,
        metadata,
        sourceInstance: this.instanceId,
      }),
    ).catch(() => {});
  }

  updatePresence(socket: WebSocket, metadata: Record<string, unknown>): void {
    const wsClient = this.clientMap.get(socket);
    if (!wsClient || wsClient.presenceMetadata === null) return;

    wsClient.presenceMetadata = metadata;

    const listener = this.listeners.get(wsClient.appId);
    if (!listener) return;

    // Broadcast to all other presence-tracking clients
    for (const other of listener.subscribers) {
      if (other.socket !== socket && other.presenceMetadata !== null) {
        this.send(other.socket, {
          type: 'presence_update',
          client_id: wsClient.clientId,
          metadata,
        });
      }
    }

    getRedisPubClient().publish(
      `realtime:presence:${wsClient.appId}`,
      JSON.stringify({
        type: 'update',
        clientId: wsClient.clientId,
        metadata,
        sourceInstance: this.instanceId,
      }),
    ).catch(() => {});
  }

  // --------------------------------------------------------------------------
  // LISTEN connection management
  // --------------------------------------------------------------------------

  private async connectListener(listener: AppListener): Promise<void> {
    try {
      // LISTEN/NOTIFY does NOT work through transaction-pooled connections
      // — the backend session that pg_notify executes on is briefly leased
      // from the pool and returned afterwards, so our client never sees the
      // delivered NotificationResponse. We resolve a direct (session-mode)
      // endpoint for the LISTEN client:
      //
      //   * Neon stores the pooler URL in connection_string (host has the
      //     "-pooler" infix). Rewrite the host to the direct endpoint by
      //     stripping "-pooler" — same hostname format, session-mode port.
      //   * Local docker dev points at the literal "pgbouncer" host. Fall
      //     through to the direct dataPlaneDb config.
      //   * Other connection_strings are assumed already-direct.
      let resolvedUrl: string | null = listener.connectionString;
      if (resolvedUrl) {
        try {
          const url = new URL(resolvedUrl);
          if (url.hostname === 'pgbouncer' || url.hostname.startsWith('pgbouncer.')) {
            resolvedUrl = null;
          } else if (url.hostname.includes('-pooler.') && /\.neon\.tech$/.test(url.hostname)) {
            url.hostname = url.hostname.replace('-pooler.', '.');
            resolvedUrl = url.toString();
          }
        } catch {
          // Malformed URL — leave as-is and let pg.Client surface the error.
        }
      }

      const needsSsl = resolvedUrl
        ? /sslmode=(require|verify-ca|verify-full)|\.neon\.tech/.test(resolvedUrl)
        : false;
      const clientConfig = resolvedUrl
        ? {
            connectionString: resolvedUrl,
            ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
          }
        : {
            host: config.dataPlaneDb.host,
            port: config.dataPlaneDb.port,
            user: config.dataPlaneDb.user,
            password: config.dataPlaneDb.password,
            database: listener.dbName,
          };

      const client = new pg.Client(clientConfig);
      listener.client = client;

      await client.connect();
      await client.query('LISTEN realtime_changes');

      listener.connected = true;
      listener.reconnectAttempts = 0;

      client.on('notification', (msg) => {
        if (msg.channel === 'realtime_changes' && msg.payload) {
          getRedisPubClient().publish(
            `realtime:changes:${listener.appId}`,
            JSON.stringify({ changeId: msg.payload, sourceInstance: this.instanceId }),
          ).catch((err) => {
            this.log.error({ err, appId: listener.appId }, '[Realtime] Failed to publish change to Redis');
            // Fallback: handle locally if Redis publish fails
            this.handleNotification(listener.appId, msg.payload!).catch(() => {});
          });
        }
      });

      client.on('error', (err) => {
        this.log.error({ err, appId: listener.appId }, '[Realtime] LISTEN connection error');
        this.handleDisconnect(listener);
      });

      client.on('end', () => {
        this.log.warn({ appId: listener.appId }, '[Realtime] LISTEN connection ended');
        this.handleDisconnect(listener);
      });

      this.log.info({ appId: listener.appId }, '[Realtime] LISTEN connection established');
    } catch (err) {
      this.log.error({ err, appId: listener.appId }, '[Realtime] Failed to connect LISTEN');
      this.handleDisconnect(listener);
    }
  }

  private handleDisconnect(listener: AppListener): void {
    if (!listener.connected && !listener.client) return; // already handled
    listener.connected = false;
    if (listener.client) {
      listener.client.removeAllListeners();
      listener.client = null;
    }

    // Notify subscribers
    for (const wsClient of listener.subscribers) {
      this.send(wsClient.socket, {
        type: 'error',
        message: 'Realtime connection lost. Reconnecting...',
      });
    }

    // Reconnect with exponential backoff
    const maxAttempts = 10;
    if (listener.reconnectAttempts < maxAttempts && listener.subscribers.size > 0) {
      const delay = Math.min(1000 * Math.pow(2, listener.reconnectAttempts), 30000);
      listener.reconnectAttempts++;

      listener.reconnectTimer = setTimeout(() => {
        listener.reconnectTimer = null;
        this.log.info(
          { appId: listener.appId, attempt: listener.reconnectAttempts },
          '[Realtime] Reconnecting LISTEN...'
        );
        this.connectListener(listener).catch(() => {});
      }, delay);
    } else if (listener.subscribers.size === 0) {
      this.teardownListener(listener.appId);
    } else {
      this.log.error({ appId: listener.appId }, '[Realtime] Max reconnect attempts reached');
      // Notify and disconnect all subscribers
      for (const wsClient of listener.subscribers) {
        this.send(wsClient.socket, {
          type: 'error',
          message: 'Realtime connection permanently lost. Please reconnect.',
        });
        wsClient.socket.close(1011, 'Upstream connection lost');
      }
      this.teardownListener(listener.appId);
    }
  }

  private teardownListener(appId: string): void {
    const listener = this.listeners.get(appId);
    if (!listener) return;

    if (listener.reconnectTimer) clearTimeout(listener.reconnectTimer);
    if (listener.teardownTimer) clearTimeout(listener.teardownTimer);

    if (listener.client) {
      listener.client.removeAllListeners();
      listener.client.end().catch(() => {});
    }

    // Clean up any remaining client mappings
    for (const wsClient of listener.subscribers) {
      this.clientMap.delete(wsClient.socket);
    }

    const sub = getRedisSubClient();
    sub.unsubscribe(`realtime:changes:${appId}`, `realtime:presence:${appId}`).catch(() => {});

    this.listeners.delete(appId);
    // Drop the presence entry so cluster-wide active_connection flips off
    // without waiting for the TTL.
    this.removePresence(appId).catch(() => {});

    this.log.info({ appId }, '[Realtime] LISTEN connection torn down');
  }

  // --------------------------------------------------------------------------
  // Redis cross-instance handlers
  // --------------------------------------------------------------------------

  private async handleRedisChange(appId: string, message: string): Promise<void> {
    const { changeId } = JSON.parse(message);
    const listener = this.listeners.get(appId);
    if (!listener || listener.subscribers.size === 0) return;
    await this.handleNotification(appId, changeId);
  }

  private handleRedisPresence(appId: string, message: string): void {
    const event = JSON.parse(message);
    if (event.sourceInstance === this.instanceId) return;

    const listener = this.listeners.get(appId);
    if (!listener) return;

    for (const wsClient of listener.subscribers) {
      if (wsClient.presenceMetadata === null) continue;

      if (event.type === 'join') {
        this.send(wsClient.socket, {
          type: 'presence_join',
          client_id: event.clientId,
          user_id: event.userId,
          metadata: event.metadata,
        });
      } else if (event.type === 'leave') {
        this.send(wsClient.socket, {
          type: 'presence_leave',
          client_id: event.clientId,
          user_id: event.userId,
        });
      } else if (event.type === 'update') {
        this.send(wsClient.socket, {
          type: 'presence_update',
          client_id: event.clientId,
          metadata: event.metadata,
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // Notification handling + RLS filtering
  // --------------------------------------------------------------------------

  private async handleNotification(appId: string, changeId: string): Promise<void> {
    const listener = this.listeners.get(appId);
    if (!listener || listener.subscribers.size === 0) return;

    // Fetch the change record from the app DB
    let change: ChangeRecord;
    try {
      const pool = await getAppPoolForApp(this.controlDb, appId, listener.dbName);
      const result = await pool.query<ChangeRecord>(
        'SELECT id, table_name, op, record, old_record, created_at FROM realtime.changes WHERE id = $1',
        [changeId]
      );
      if (result.rows.length === 0) return;
      change = result.rows[0];
    } catch (err) {
      this.log.error({ err, appId, changeId }, '[Realtime] Failed to fetch change record');
      return;
    }

    // Find subscribers watching this table, applying filter matching
    const changeRecord = change.op === 'DELETE' ? change.old_record : change.record;
    const interestedClients: WsClient[] = [];
    for (const wsClient of listener.subscribers) {
      const filter = wsClient.subscribedTables.get(change.table_name);
      if (filter === undefined) continue; // not subscribed to this table

      // Apply filter matching (cheaper than RLS — pure in-memory)
      if (filter && changeRecord) {
        const matches = Object.entries(filter).every(([col, val]) => changeRecord[col] === val);
        if (!matches) continue;
      }

      interestedClients.push(wsClient);
    }
    if (interestedClients.length === 0) return;

    // Group clients by (role, userId) for batched RLS checks
    const groups = new Map<string, WsClient[]>();
    for (const client of interestedClients) {
      const key = `${client.role}:${client.userId ?? ''}`;
      const group = groups.get(key);
      if (group) {
        group.push(client);
      } else {
        groups.set(key, [client]);
      }
    }

    // Determine record's primary key for RLS checks
    const record = change.op === 'DELETE' ? change.old_record : change.record;
    const pool = await getAppPoolForApp(this.controlDb, appId, listener.dbName);

    // Discover the primary key column for this table
    const pkCol = await this.getPrimaryKeyColumn(pool, change.table_name);
    const recordPk = pkCol && record ? record[pkCol] : undefined;

    // RLS check + broadcast per group
    for (const [, clients] of groups) {
      const { role, userId } = clients[0];

      // Service role skips RLS
      if (role === 'butterbase_service') {
        for (const c of clients) this.sendChange(c.socket, change);
        continue;
      }

      // Fail-closed: we can only enforce RLS on delivery when a single-column
      // PK is available to filter on inside rlsCheck's SELECT. Without one
      // (no PK, composite PK, or a transient DB error resolving it) we can't
      // ask Postgres "does this row satisfy the policy for THIS record?", so
      // drop the change for non-service roles instead of broadcasting. Prior
      // behavior fell through to sendChange, leaking the row to every anon
      // subscriber on any RLS-protected PK-less table.
      if (!pkCol || recordPk === undefined) {
        this.log.warn(
          { appId, table: change.table_name, role, hasPk: !!pkCol, hasRecord: !!record },
          '[Realtime] dropping change: no usable single-column PK for RLS check',
        );
        continue;
      }
      const canSee = await this.rlsCheck(pool, change.table_name, pkCol, String(recordPk), role, userId);
      if (!canSee) continue;

      for (const c of clients) this.sendChange(c.socket, change);
    }
  }

  /** Cache of table → primary key column name */
  private pkCache = new Map<string, { col: string | null; expires: number }>();

  private async getPrimaryKeyColumn(pool: pg.Pool, table: string): Promise<string | null> {
    const cached = this.pkCache.get(table);
    if (cached && cached.expires > Date.now()) return cached.col;

    try {
      const result = await pool.query(
        `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = $1::regclass AND i.indisprimary`,
        [table]
      );
      // Only single-column PKs are usable here — rlsCheck's WHERE filters on
      // exactly one column. A composite PK with the pre-fix LIMIT 1 would
      // filter on one of the columns and match rows that share that value
      // (wrong row, wrong RLS answer). Treat composite and no-PK the same;
      // callers fail closed for non-service roles.
      const col = result.rows.length === 1 ? result.rows[0].attname : null;
      // Only cache positive results. Caching null poisoned the cache for 60s
      // on any transient DB blip and silently disabled RLS on the table for
      // that window — every subsequent event during it would broadcast.
      if (col !== null) this.pkCache.set(table, { col, expires: Date.now() + 60000 });
      return col;
    } catch {
      return null;
    }
  }

  private async rlsCheck(
    pool: pg.Pool,
    table: string,
    pkColumn: string,
    recordPk: string,
    role: 'butterbase_anon' | 'butterbase_user' | 'butterbase_service',
    userId: string | null
  ): Promise<boolean> {
    // Defense in depth — the delivery gate already refuses to call us without
    // a pkColumn, but a future caller wiring us up wrong shouldn't be able to
    // turn the WHERE clause into a table scan.
    if (!pkColumn) return false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`SET LOCAL ROLE ${role}`);

      await client.query(`SET LOCAL app.role = '${role}'`);
      if (role === 'butterbase_user' && userId) {
        await client.query(`SET LOCAL request.jwt.claim.sub = '${userId.replace(/'/g, "''")}'`);
      }

      const result = await client.query(
        `SELECT 1 FROM "${table}" WHERE "${pkColumn}" = $1 LIMIT 1`,
        [recordPk]
      );
      await client.query('COMMIT');
      return result.rows.length > 0;
    } catch {
      await client.query('ROLLBACK').catch(() => {});
      return false;
    } finally {
      client.release();
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private sendChange(socket: WebSocket, change: ChangeRecord): void {
    this.send(socket, {
      type: 'change',
      table: change.table_name,
      op: change.op,
      record: change.record,
      old_record: change.old_record,
      timestamp: change.created_at,
    });
  }

  private send(socket: WebSocket, data: unknown): void {
    if (socket.readyState === 1 /* WebSocket.OPEN */) {
      socket.send(JSON.stringify(data));
    }
  }

  private async cleanupOldChanges(): Promise<void> {
    for (const listener of this.listeners.values()) {
      if (!listener.connected) continue;
      try {
        const pool = await getAppPoolForApp(this.controlDb, listener.appId, listener.dbName);
        await pool.query('SELECT realtime.cleanup_old_changes()');
      } catch {
        // Non-critical — will retry next cycle
      }
    }
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  getStats(): { listenConnections: number; wsClients: number; apps: string[] } {
    return {
      listenConnections: this.listeners.size,
      wsClients: this.clientMap.size,
      apps: Array.from(this.listeners.keys()),
    };
  }
}
