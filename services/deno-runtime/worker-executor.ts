// Isolated function executor using Web Workers
import type { FunctionMetadata } from "./function-loader.ts";

export interface LogEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: number;
}

export interface ExecutionResult {
  success: boolean;
  timeout?: boolean;
  response?: {
    status: number;
    headers: Record<string, string>;
    bodyBase64: string;
  };
  error?: {
    message: string;
    stack?: string;
  };
  logs: LogEntry[];
  metrics: {
    duration_ms: number;
    memory_used_mb: number;
  };
}

export async function executeFunction(
  metadata: FunctionMetadata,
  request: Request,
  userId?: string
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const startMemory = (performance as any).memory?.usedJSHeapSize || 0;

  // Collect console.log/warn/error output from the worker (max 100 entries, 10KB each)
  // Declared outside try block so catch (timeout) can still access captured logs
  const MAX_LOG_ENTRIES = 100;
  const MAX_LOG_LENGTH = 10_000;
  const collectedLogs: LogEntry[] = [];

  try {
    // Build database URL for this app
    const dbUrl = buildDatabaseUrl(metadata.app_id, metadata.db_connection_string);

    // Parse request
    const requestBody = request.body ? await request.text() : null;
    const requestHeaders = Object.fromEntries(request.headers.entries());

    // Reconstruct public API URL instead of internal runtime URL
    const url = new URL(request.url);
    const publicUrl = reconstructPublicUrl(metadata.app_id, metadata.name, url);

    // Create worker code
    const workerCode = buildWorkerCode(metadata, {
      dbUrl,
      requestUrl: publicUrl,
      requestMethod: request.method,
      requestHeaders,
      requestBody,
      userId,
    });

    // Execute in Web Worker with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, metadata.timeout_ms);

    const worker = new Worker(
      URL.createObjectURL(
        new Blob([workerCode], { type: "application/typescript" })
      ),
      {
        type: "module",
        deno: {
          permissions: {
            net: true,
            env: true,
            read: false,
            write: false,
            run: false,
            ffi: false,
          },
        },
      }
    );

    // Two-phase worker lifecycle:
    // Phase 1: Worker sends response (type "success"/"error") — resolve immediately
    // Phase 2: Worker awaits waitUntil promises, then sends "done" — terminate worker
    const WAIT_UNTIL_TIMEOUT_MS = 30_000;

    const result = await new Promise<any>((resolve, reject) => {
      let responded = false;

      worker.onmessage = (e) => {
        // Capture console log messages (sent before and after response)
        if (e.data.type === "console" && collectedLogs.length < MAX_LOG_ENTRIES) {
          collectedLogs.push({
            level: e.data.level,
            message: String(e.data.message).slice(0, MAX_LOG_LENGTH),
            timestamp: e.data.timestamp,
          });
          return;
        }

        if (!responded && (e.data.type === "success" || e.data.type === "error")) {
          // Phase 1: Got the response — resolve promise so caller gets it fast
          responded = true;
          clearTimeout(timeoutId);
          resolve(e.data);

          // Keep worker alive for waitUntil promises, with a safety timeout
          const bgTimeoutId = setTimeout(() => {
            worker.terminate();
          }, WAIT_UNTIL_TIMEOUT_MS);

          // Listen for the "done" signal from the worker
          worker.onmessage = (e2) => {
            if (e2.data.type === "done") {
              clearTimeout(bgTimeoutId);
              worker.terminate();
            }
          };

          // If worker errors during background phase, just terminate
          worker.onerror = () => {
            clearTimeout(bgTimeoutId);
            worker.terminate();
          };
        }
      };

      worker.onerror = (e) => {
        clearTimeout(timeoutId);
        reject(new Error(`Worker error: ${e.message}`));
      };

      controller.signal.addEventListener("abort", () => {
        worker.terminate();
        reject(
          new Error(`Function execution timeout (${metadata.timeout_ms}ms)`)
        );
      });
    });

    const duration = Date.now() - startTime;
    const endMemory = (performance as any).memory?.usedJSHeapSize || 0;
    const memoryUsed = Math.max(0, (endMemory - startMemory) / 1024 / 1024);

    if (result.type === "error") {
      return {
        success: false,
        error: {
          message: result.error.message,
          stack: result.error.stack,
        },
        logs: collectedLogs,
        metrics: {
          duration_ms: duration,
          memory_used_mb: memoryUsed,
        },
      };
    }

    const response = result.response;
    const isHttpError = response.status >= 400;

    return {
      success: !isHttpError,
      response,
      error: isHttpError ? { message: `HTTP ${response.status}` } : undefined,
      logs: collectedLogs,
      metrics: {
        duration_ms: duration,
        memory_used_mb: memoryUsed,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const endMemory = (performance as any).memory?.usedJSHeapSize || 0;
    const memoryUsed = Math.max(0, (endMemory - startMemory) / 1024 / 1024);
    const isTimeout = (error as Error).message?.includes("Function execution timeout");

    return {
      success: false,
      timeout: isTimeout,
      error: {
        message: (error as Error).message,
        stack: (error as Error).stack,
      },
      logs: collectedLogs,
      metrics: {
        duration_ms: duration,
        memory_used_mb: memoryUsed,
      },
    };
  }
}

function buildDatabaseUrl(appId: string, cachedConnectionString: string | null): string | null {
  // Always prefer the connection string from app_db_connections when available.
  // This works for both Neon (direct URI) and local (PgBouncer URI) deployments.
  if (cachedConnectionString) {
    return cachedConnectionString;
  }

  // Fallback: build from PGBOUNCER env vars (for apps without app_db_connections)
  const host = Deno.env.get("PGBOUNCER_HOST");
  const port = Deno.env.get("PGBOUNCER_PORT");
  const user = Deno.env.get("PGBOUNCER_USER");
  const password = Deno.env.get("PGBOUNCER_PASSWORD");

  // If any required env var is missing, return null (DB not available)
  if (!host || !port || !user || !password) {
    return null;
  }

  // CRITICAL: ?pgbouncer=true disables prepared statements
  return `postgresql://${user}:${password}@${host}:${port}/${appId}?pgbouncer=true`;
}

/**
 * Reconstructs the public API URL from the internal runtime URL
 * Converts /execute/:appId/:functionName to /v1/:appId/fn/:functionName
 */
function reconstructPublicUrl(appId: string, functionName: string, internalUrl: URL): string {
  const apiBaseUrl = Deno.env.get("API_BASE_URL") || "http://localhost:4000";

  // Preserve query string and hash
  const search = internalUrl.search;
  const hash = internalUrl.hash;

  return `${apiBaseUrl}/v1/${appId}/fn/${functionName}${search}${hash}`;
}

function buildWorkerCode(
  metadata: FunctionMetadata,
  context: {
    dbUrl: string;
    requestUrl: string;
    requestMethod: string;
    requestHeaders: Record<string, string>;
    requestBody: string | null;
    userId?: string;
  }
): string {
  return `
    import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

    // Sandbox: replace Deno.env with a frozen stub so user code and
    // library internals cannot read host environment variables.
    // The Postgres library gets undefined (no crash), user code gets
    // undefined (no leak). configurable:false prevents user code from
    // restoring the original.
    Object.defineProperty(Deno, "env", {
      value: Object.freeze({
        get() { return undefined; },
        set() {},
        delete() {},
        has() { return false; },
        toObject() { return {}; },
      }),
      writable: false,
      configurable: false,
    });

    // Capture console output and forward to host via postMessage
    const __origConsole = { ...console };
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      console[level] = (...args) => {
        __origConsole[level](...args);
        try {
          self.postMessage({
            type: "console",
            level,
            message: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '),
            timestamp: Date.now(),
          });
        } catch { /* postMessage may fail for non-serializable args */ }
      };
    }

    // User's function code
    ${metadata.code}

    // Execution wrapper - only create Pool if dbUrl is available
    const dbUrl = "${context.dbUrl}";
    const db = dbUrl && dbUrl !== "null" ? new Pool(dbUrl, 1, { connection: { attempts: 1 } }) : null;

    // Reconstruct Request
    const request = new Request("${context.requestUrl}", {
      method: "${context.requestMethod}",
      headers: ${JSON.stringify(context.requestHeaders)},
      ${context.requestBody ? `body: ${JSON.stringify(context.requestBody)},` : ""}
    });

    // Shared row converter for BigInt compatibility
    function convertRows(rows) {
      return rows.map(row => {
        const converted = {};
        for (const [key, value] of Object.entries(row)) {
          converted[key] = typeof value === 'bigint' ? Number(value) : value;
        }
        return converted;
      });
    }

    // Helper to acquire a pool client with timeout
    async function acquireClient() {
      const client = await Promise.race([
        db.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(
            "Database connection timeout (5s). The database may be unreachable or experiencing issues."
          )), 5000)
        ),
      ]);
      // PgBouncer reuses backend sessions across clients. If a prior client
      // ran LISTEN on this backend, our connection inherits the subscription
      // and pg_notify (e.g. from realtime triggers) delivers an async
      // NotificationResponse that deno-postgres@0.19.3 cannot decode mid-query
      // ("Unexpected simple query message: A"). UNLISTEN * is a no-op on a
      // clean session and defuses inherited subscriptions.
      try { await client.queryArray('UNLISTEN *'); } catch { /* best-effort */ }
      return client;
    }

    // Tolerant COMMIT: deno-postgres@0.19.3 may throw on async notifications
    // arriving alongside the COMMIT response. The transaction has persisted
    // server-side at that point; re-sync via a trivial query and proceed.
    async function safeCommit(client) {
      try {
        await client.queryArray('COMMIT');
      } catch (err) {
        const msg = String((err && err.message) || err);
        if (msg.indexOf('Unexpected simple query message: A') !== -1) {
          try {
            await client.queryArray('SELECT 1');
            return;
          } catch {
            // Connection is poisoned. Drop it instead of returning to the pool.
            try { await client.end?.(); } catch { /* ignore */ }
            throw err;
          }
        }
        throw err;
      }
    }

    // waitUntil promises — collected by ctx.waitUntil(), awaited after response is sent
    const __waitUntilPromises = [];

    // Execution context
    // BUTTERBASE_APP_ID and BUTTERBASE_API_URL are platform-reserved vars injected
    // after user env so they cannot be shadowed by user-defined envVars.
    const ctx = {
      waitUntil: (promise) => {
        __waitUntilPromises.push(Promise.resolve(promise));
      },
      db: db ? {
        query: async (sql, params) => {
          const client = await acquireClient();
          try {
            await client.queryArray('BEGIN');

            // Switch to non-privileged role so RLS is enforced
            // (connection role has BYPASSRLS on Neon, so RLS is skipped without this)
            ${context.userId ? `
              // End-user invocation: butterbase_user role
              await client.queryArray("SET LOCAL ROLE butterbase_user");
              await client.queryArray("SET LOCAL app.role = 'butterbase_user'");
              await client.queryArray(
                "SELECT set_config('request.jwt.claim.sub', $1, true)",
                ["${context.userId.replace(/'/g, "''")}"]
              );
            ` : `
              // Service/cron invocation: butterbase_service role
              await client.queryArray("SET LOCAL ROLE butterbase_service");
              await client.queryArray("SET LOCAL app.role = 'butterbase_service'");
            `}

            const result = await client.queryObject(sql, params);
            await safeCommit(client);
            return { rows: convertRows(result.rows) };
          } catch (error) {
            try { await client.queryArray('ROLLBACK'); } catch { /* preserve original error */ }
            throw error;
          } finally {
            client.release();
          }
        },

        // Simulate queries as a specific end-user (butterbase_user role with RLS enforced)
        asUser: async (userId, callback) => {
          const client = await acquireClient();
          try {
            await client.queryArray('BEGIN');
            await client.queryArray("SET LOCAL ROLE butterbase_user");
            await client.queryArray("SET LOCAL app.role = 'butterbase_user'");
            await client.queryArray(
              "SELECT set_config('request.jwt.claim.sub', $1, true)",
              [String(userId)]
            );
            const scopedDb = {
              query: async (sql, params) => {
                const result = await client.queryObject(sql, params);
                return { rows: convertRows(result.rows) };
              }
            };
            const returnValue = await callback(scopedDb);
            await safeCommit(client);
            return returnValue;
          } catch (error) {
            try { await client.queryArray('ROLLBACK'); } catch { /* preserve original error */ }
            throw error;
          } finally {
            client.release();
          }
        },

        // Simulate queries as an anonymous user (butterbase_anon role with RLS enforced)
        asAnon: async (callback) => {
          const client = await acquireClient();
          try {
            await client.queryArray('BEGIN');
            await client.queryArray("SET LOCAL ROLE butterbase_anon");
            await client.queryArray("SET LOCAL app.role = 'butterbase_anon'");
            const scopedDb = {
              query: async (sql, params) => {
                const result = await client.queryObject(sql, params);
                return { rows: convertRows(result.rows) };
              }
            };
            const returnValue = await callback(scopedDb);
            await safeCommit(client);
            return returnValue;
          } catch (error) {
            try { await client.queryArray('ROLLBACK'); } catch { /* preserve original error */ }
            throw error;
          } finally {
            client.release();
          }
        },
      } : null,
      env: ${JSON.stringify({
        ...metadata.env_vars,
        BUTTERBASE_APP_ID: metadata.app_id,
        BUTTERBASE_API_URL: Deno.env.get("API_BASE_URL") || "http://localhost:4000",
      })},
      user: ${context.userId ? `{ id: "${context.userId}" }` : "null"},
      idempotency: db ? {
        // Atomically claim a key. Returns true if newly claimed (caller should
        // proceed), false if the key was already processed (caller should treat
        // the request as a duplicate and return 2xx without doing the work).
        // Keys are scoped per app (separate from any other app) and may be
        // optionally namespaced via opts.scope. Pass opts.ttlSeconds to mark
        // the claim for cleanup; the user is responsible for actually deleting
        // (DELETE FROM _idempotency_keys WHERE expires_at < now()).
        claim: async (key, opts) => {
          if (typeof key !== 'string' || key.length === 0) {
            throw new Error('ctx.idempotency.claim(key): key must be a non-empty string');
          }
          if (key.length > 255) {
            throw new Error('ctx.idempotency.claim(key): key must be <= 255 chars');
          }
          const scope = (opts && typeof opts.scope === 'string') ? opts.scope : 'default';
          const ttlSec = opts && typeof opts.ttlSeconds === 'number' && opts.ttlSeconds > 0
            ? Math.floor(opts.ttlSeconds)
            : null;
          const client = await acquireClient();
          try {
            await client.queryArray('BEGIN');
            // Always run as butterbase_service so the claim succeeds regardless
            // of who triggered the function (anon webhook, user, cron).
            await client.queryArray("SET LOCAL ROLE butterbase_service");
            const result = await client.queryObject(
              \`INSERT INTO _idempotency_keys (scope, key, expires_at)
               VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL
                                    ELSE now() + ($3 || ' seconds')::interval END)
               ON CONFLICT (scope, key) DO NOTHING
               RETURNING key\`,
              [scope, key, ttlSec]
            );
            await safeCommit(client);
            return result.rows.length === 1;
          } catch (error) {
            try { await client.queryArray('ROLLBACK'); } catch { /* ignore */ }
            throw error;
          } finally {
            client.release();
          }
        },
      } : null,
      // ctx.kv — key/value store backed by the kv-gateway Worker.
      // KV_GATEWAY_URL must be set in the deno-runtime environment for ctx.kv to be available.
      // If it is not set, ctx.kv is undefined and function code that tries to use it will receive
      // a clear TypeError ("Cannot read properties of undefined") rather than a silent failure.
      // The gateway address for local development is http://kv-gateway:8787 (Task 14 wires that up).
      ${Deno.env.get("KV_GATEWAY_URL") ? `
      kv: (() => {
        const __kvBase = ${JSON.stringify(Deno.env.get("KV_GATEWAY_URL"))};
        const __kvRoot = __kvBase + "/v1/" + ${JSON.stringify(metadata.app_id)} + "/kv";
        const __kvHeaders = {
          authorization: "Bearer " + ${JSON.stringify(metadata.env_vars?.BUTTERBASE_SERVICE_KEY || Deno.env.get("BUTTERBASE_FUNCTION_SERVICE_KEY") || '')},
          "content-type": "application/json",
        };
        async function __kvCall(method, key, body) {
          return fetch(__kvRoot + "/" + key, {
            method,
            headers: __kvHeaders,
            body: body === undefined ? undefined : JSON.stringify(body),
          });
        }
        function __kvThrow(res, body) {
          const msg = (body && body.message) ? body.message : ("kv error (status " + res.status + ")");
          const code = (body && body.error) ? body.error : "KV_ERROR";
          const err = new Error(msg);
          err.name = res.status === 400 ? "KvKeyInvalidError"
                   : res.status === 401 ? "KvAuthError"
                   : res.status === 403 ? "KvForbiddenError"
                   : res.status === 503 ? "KvConnectionError"
                   : "KvError";
          err.code = code;
          err.status = res.status;
          throw err;
        }
        return {
          async get(key) {
            const res = await __kvCall("GET", key);
            if (res.status === 404) return null;
            if (!res.ok) __kvThrow(res, await res.json().catch(() => null));
            return (await res.json()).value;
          },
          async set(key, value) {
            const res = await __kvCall("PUT", key, { value });
            if (!res.ok && res.status !== 204) __kvThrow(res, await res.json().catch(() => null));
          },
          async del(key) {
            const res = await __kvCall("DELETE", key);
            if (res.status === 204) return 1;
            if (res.status === 404) return 0;
            __kvThrow(res, await res.json().catch(() => null));
          },
        };
      })(),
      ` : '/* ctx.kv: KV_GATEWAY_URL not set — kv omitted from ctx */'}
      integrations: {
        execute: async (toolName, params) => {
          const apiUrl = ${JSON.stringify(Deno.env.get("API_BASE_URL") || "http://localhost:4000")};
          const serviceKey = ${JSON.stringify(metadata.env_vars?.BUTTERBASE_SERVICE_KEY || Deno.env.get("BUTTERBASE_FUNCTION_SERVICE_KEY") || '')};
          const res = await fetch(apiUrl + "/v1/" + ${JSON.stringify(metadata.app_id)} + "/integrations/execute", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(serviceKey ? { "Authorization": "Bearer " + serviceKey } : {}),
            },
            body: JSON.stringify({
              toolName,
              params,
              ${context.userId ? `userId: ${JSON.stringify(context.userId)},` : ''}
            }),
          });
          return res.json();
        },
        asUser: (userId) => ({
          execute: async (toolName, params) => {
            const apiUrl = ${JSON.stringify(Deno.env.get("API_BASE_URL") || "http://localhost:4000")};
            const serviceKey = ${JSON.stringify(metadata.env_vars?.BUTTERBASE_SERVICE_KEY || Deno.env.get("BUTTERBASE_FUNCTION_SERVICE_KEY") || '')};
            const res = await fetch(apiUrl + "/v1/" + ${JSON.stringify(metadata.app_id)} + "/integrations/execute", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(serviceKey ? { "Authorization": "Bearer " + serviceKey } : {}),
              },
              body: JSON.stringify({ toolName, params, userId }),
            });
            return res.json();
          },
        }),
      },
    };

    // Execute handler
    try {
      const response = await handler(request, ctx);

      // Get body as ArrayBuffer to preserve binary data
      const bodyBuffer = await response.arrayBuffer();
      const bodyArray = new Uint8Array(bodyBuffer);

      // Encode as base64 for safe serialization through postMessage
      // Use a more efficient method that doesn't spread the array
      let binary = '';
      for (let i = 0; i < bodyArray.length; i++) {
        binary += String.fromCharCode(bodyArray[i]);
      }
      const base64 = btoa(binary);

      const serialized = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bodyBase64: base64,
      };

      // Phase 1: Send response immediately so caller gets it fast
      self.postMessage({ type: "success", response: serialized });

      // Phase 2: Await any waitUntil promises (background work)
      if (__waitUntilPromises.length > 0) {
        await Promise.allSettled(__waitUntilPromises);
      }
    } catch (error) {
      self.postMessage({
        type: "error",
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      });
    } finally {
      if (db) {
        await Promise.race([
          db.end(),
          new Promise(resolve => setTimeout(resolve, 2000))
        ]);
      }
      // Signal that all background work is done — main thread can terminate worker
      self.postMessage({ type: "done" });
    }
  `;
}
