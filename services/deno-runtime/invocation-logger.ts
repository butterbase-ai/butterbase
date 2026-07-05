// Invocation logger for usage tracking and debugging
import { Pool, type PoolClient } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { isDeadConnectionError } from "./function-loader.ts";
import type { FunctionMetadata } from "./function-loader.ts";
import type { ExecutionResult } from "./worker-executor.ts";

// function_invocations and app_functions are runtime-tier post-cutover.
// Resolve via BUTTERBASE_REGION (explicit) OR FLY_REGION +
// BUTTERBASE_FLY_REGION_MAP (derivation, matches @butterbase/shared
// loadRegionConfig). This machine only serves apps pinned to its own
// region (function-loader uses the same DB).
function resolveInstanceRegion(): string | null {
  const explicit = Deno.env.get("BUTTERBASE_REGION");
  if (explicit) return explicit;
  const fly = Deno.env.get("FLY_REGION");
  const map = Deno.env.get("BUTTERBASE_FLY_REGION_MAP");
  if (fly && map) {
    for (const pair of map.split(",")) {
      const [k, v] = pair.split(":").map((s) => s.trim());
      if (k === fly && v) return v;
    }
  }
  return null;
}

function getRuntimeDbUrl(): string {
  const region = resolveInstanceRegion();
  if (region) {
    const suffix = region.toUpperCase().replace(/-/g, "_");
    const envKey = `NEON_RUNTIME_PROJECT_ID_${suffix}`;
    const url = Deno.env.get(envKey);
    if (url) return url;
    console.warn(
      `[invocation-logger] ${envKey} not set; falling back to CONTROL_PLANE_URL`,
    );
  } else {
    console.warn(
      `[invocation-logger] could not resolve region from BUTTERBASE_REGION or FLY_REGION+BUTTERBASE_FLY_REGION_MAP; falling back to CONTROL_PLANE_URL`,
    );
  }
  const fallback = Deno.env.get("CONTROL_PLANE_URL");
  if (!fallback) {
    throw new Error(
      "Runtime DB URL not configured: set BUTTERBASE_REGION (or FLY_REGION + " +
        "BUTTERBASE_FLY_REGION_MAP) + NEON_RUNTIME_PROJECT_ID_<REGION>, or CONTROL_PLANE_URL (legacy)",
    );
  }
  return fallback;
}

// Separate pool for logging (don't block function execution)
const loggingPool = new Pool(getRuntimeDbUrl(), 5);

// Mirror of function-loader's dead-conn recovery: Neon idle-evicts pooled
// TCP sessions, so the first write on a checked-out client can hit BrokenPipe
// (or a deno-postgres "session was terminated" surface) and otherwise drop
// the function_invocations row for that call.
async function dropLoggingClient(client: PoolClient): Promise<void> {
  try { await (client as unknown as { end?: () => Promise<void> }).end?.(); } catch { /* ignore */ }
  try { client.release(); } catch { /* ignore */ }
}

async function withLoggingClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const client = await loggingPool.connect();
    try {
      const result = await fn(client);
      client.release();
      return result;
    } catch (err) {
      await dropLoggingClient(client);
      if (attempt === 1 || !isDeadConnectionError(err)) throw err;
      console.warn(
        `[invocation-logger] loggingPool dead connection (${(err as Error).message ?? err}); retrying once`,
      );
    }
  }
  throw new Error("withLoggingClient: exhausted retries");
}

export async function logInvocation(
  metadata: FunctionMetadata,
  request: Request,
  result: ExecutionResult,
  userId?: string,
  callerType?: "service_key" | "end_user_jwt" | "loopback" | "anonymous"
): Promise<void> {
  try {
    const requestBodySize = request.headers.get("content-length")
      ? parseInt(request.headers.get("content-length")!)
      : 0;

    const responseBodySize = result.response?.body?.length || 0;

    // Status code recorded for the invocation: prefer the handler's response,
    // otherwise mirror what server.ts returns to the caller for thrown / timeout errors.
    const statusCode = result.response?.status ?? (result.timeout ? 504 : (result.success ? null : 500));

    // app_user_id is only populated for genuine end-user JWT calls; service-key
    // impersonation also populates user_id but is NOT a real end-user action.
    const appUserId = callerType === "end_user_jwt" && userId ? userId : null;

    // Billed duration: round up to nearest 100ms
    const billedDuration = Math.ceil(result.metrics.duration_ms / 100) * 100;

    // Billed memory: round up to nearest MB
    const billedMemory = Math.ceil(result.metrics.memory_used_mb);

    // Log invocation
    await withLoggingClient(async (client) => {
      await client.queryObject(
        `INSERT INTO function_invocations (
          function_id, app_id, user_id, app_user_id, method, path, headers,
          request_body_size_bytes, status_code, response_body_size_bytes,
          duration_ms, memory_used_mb, error_message, error_stack,
          started_at, completed_at, billed_duration_ms, billed_memory_mb,
          console_logs
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          metadata.id,
          metadata.app_id,
          userId || null,
          appUserId,
          request.method,
          new URL(request.url).pathname,
          JSON.stringify(Object.fromEntries(request.headers.entries())),
          requestBodySize,
          statusCode,
          responseBodySize,
          result.metrics.duration_ms,
          result.metrics.memory_used_mb,
          result.error?.message || null,
          result.error?.stack || null,
          new Date(Date.now() - result.metrics.duration_ms).toISOString(),
          new Date().toISOString(),
          billedDuration,
          billedMemory,
          result.logs.length > 0 ? JSON.stringify(result.logs) : null,
        ]
      );

      // Update function stats (fire-and-forget — runs on the same client
      // before release; if the conn went bad mid-batch, dropLoggingClient
      // tears it down rather than returning a poisoned slot to the pool).
      client.queryObject(
        `UPDATE app_functions SET
          last_invoked_at = now(),
          last_status_code = $4,
          invocation_count = invocation_count + 1,
          error_count = error_count + CASE WHEN $2 THEN 1 ELSE 0 END,
          avg_duration_ms = (COALESCE(avg_duration_ms, 0) * invocation_count + $3) / (invocation_count + 1)
         WHERE id = $1`,
        [metadata.id, !result.success, result.metrics.duration_ms, statusCode]
      ).catch((err) => console.error("Failed to update function stats:", err));
    });
  } catch (err) {
    console.error("Failed to log invocation:", err);
  }
}
