// Butterbase Deno Runtime Server
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { loadFunction, invalidateCache, warmupRuntimePool } from "./function-loader.ts";
import { executeFunction } from "./worker-executor.ts";
import { logInvocation } from "./invocation-logger.ts";
import { startRedisSubscriber } from "./redis-subscriber.ts";

// Worker module-init failures (e.g. bad imports) fire both worker.onerror AND a
// top-level unhandledrejection via Deno's Worker.#pollControl. Without this
// handler Deno's default behaviour is to crash the entire process, taking down
// all concurrent users. We suppress it here; the per-request error path inside
// executeFunction already surfaces a 500 to the caller.
globalThis.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  console.error("[runtime] unhandled rejection suppressed:", e.reason);
});

globalThis.addEventListener("error", (e) => {
  e.preventDefault();
  console.error("[runtime] unhandled error suppressed:", e.message);
});

const PORT = parseInt(Deno.env.get("PORT") || "7133");

let activeWorkers = 0;
const MAX_CONCURRENT_WORKERS = parseInt(
  Deno.env.get("MAX_CONCURRENT_WORKERS") || "100"
);

console.log(`🦕 Butterbase Deno Runtime starting on port ${PORT}...`);
startRedisSubscriber();

// Prove the runtime DB pool is ready BEFORE we start listening. Fly's
// health-check begins probing the moment the port is open; if we accept
// traffic before the pool completes its first TCP+TLS handshake, a cron
// dispatch that lands in that window will get an empty result set from
// app_functions and 404 the caller. Blocking here means Fly's grace_period
// covers the warmup window and traffic only cuts over once we can serve.
try {
  await warmupRuntimePool();
} catch (err) {
  console.error("[runtime] warmup failed; exiting so Fly restarts us:", err);
  Deno.exit(1);
}

serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // Health check
  if (path === "/health") {
    return new Response(
      JSON.stringify({
        status: "healthy",
        activeWorkers,
        maxWorkers: MAX_CONCURRENT_WORKERS,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Cache invalidation
  if (path === "/cache/invalidate" && req.method === "POST") {
    try {
      const body = await req.json();
      const { app_id, function_name } = body;
      invalidateCache(app_id, function_name);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: (error as Error).message }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }

  // Function execution: POST /execute/:appId/:functionName
  const match = path.match(/^\/execute\/([^\/]+)\/([^\/]+)$/);
  if (!match) {
    return new Response("Not Found", { status: 404 });
  }

  const [, appId, functionName] = match;

  // Check concurrency limit
  if (activeWorkers >= MAX_CONCURRENT_WORKERS) {
    return new Response(
      JSON.stringify({
        error: "Concurrency limit reached",
        activeWorkers,
        maxWorkers: MAX_CONCURRENT_WORKERS,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "5",
        },
      }
    );
  }

  try {
    // Load function metadata
    const metadata = await loadFunction(appId, functionName);
    if (!metadata) {
      return new Response(
        JSON.stringify({ error: "Function not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Extract user ID + caller identity from platform-injected headers.
    // `x-user-id` is the effective user (end-user JWT subject, or null for
    // service-key/anonymous). `x-butterbase-caller-*` describes WHO made the
    // request: type=service_key|end_user_jwt|anonymous, plus key_id/scope for
    // service-key calls. Phase 1 surfaces these as `ctx.caller` in user code.
    const userId = req.headers.get("x-user-id") || undefined;
    const callerTypeRaw = req.headers.get("x-butterbase-caller-type");
    const callerKeyId = req.headers.get("x-butterbase-caller-key-id") || null;
    const callerScope = req.headers.get("x-butterbase-caller-scope") || null;
    const callerType: "service_key" | "end_user_jwt" | "loopback" | "anonymous" =
      callerTypeRaw === "service_key" || callerTypeRaw === "end_user_jwt" || callerTypeRaw === "loopback"
        ? callerTypeRaw
        : "anonymous";
    const caller = { type: callerType, keyId: callerKeyId, scope: callerScope, userId: userId ?? null };

    // Execute function
    activeWorkers++;
    const startTime = Date.now();

    try {
      const result = await executeFunction(metadata, req, userId, caller);

      // Log invocation (async, fire-and-forget)
      logInvocation(metadata, req, result, userId).catch((err) =>
        console.error("Failed to log invocation:", err)
      );

      if (!result.response && !result.responseStream) {
        const status = result.timeout ? 504 : 500;
        const body = result.timeout
          ? {
              error: "function_timeout",
              message: result.error?.message,
              duration_ms: result.metrics.duration_ms,
            }
          : {
              error: result.error?.message,
              stack: result.error?.stack,
            };

        return new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Streaming response (Content-Type: text/event-stream) — return the
      // ReadableStream directly so chunks reach the client as they're produced.
      // Same header hygiene as the buffered path: strip content-length/encoding
      // since both are wrong for a stream we're re-emitting.
      if (result.responseStream) {
        const sHeaders = { ...result.responseStream.headers };
        delete sHeaders["content-length"];
        delete sHeaders["Content-Length"];
        delete sHeaders["content-encoding"];
        delete sHeaders["Content-Encoding"];
        return new Response(result.responseStream.stream, {
          status: result.responseStream.status,
          headers: sHeaders,
        });
      }

      // Decode base64 body back to Uint8Array
      const bodyBase64 = result.response!.bodyBase64;
      const bodyBinary = atob(bodyBase64);
      const bodyArray = new Uint8Array(bodyBinary.length);
      for (let i = 0; i < bodyBinary.length; i++) {
        bodyArray[i] = bodyBinary.charCodeAt(i);
      }

      // Remove Content-Length and Content-Encoding headers: the body has been
      // re-materialized from base64 as raw bytes, so any encoding the user
      // function claimed (e.g. a gzip header inherited from an upstream fetch
      // whose body Deno already auto-decompressed) is now a lie and would
      // cause undici on the gateway side to attempt decompression of plaintext.
      const headers = { ...result.response!.headers };
      delete headers["content-length"];
      delete headers["Content-Length"];
      delete headers["content-encoding"];
      delete headers["Content-Encoding"];

      // Per the Fetch spec, statuses 101/204/205/304 forbid a body — even an
      // empty Uint8Array triggers "Response with null body status cannot have
      // body". Pass null when the user function returned a null-body status.
      const status = result.response!.status;
      const isNullBodyStatus = status === 101 || status === 204 || status === 205 || status === 304;

      return new Response(isNullBodyStatus ? null : bodyArray, {
        status,
        headers,
      });
    } finally {
      activeWorkers--;
    }
  } catch (error) {
    console.error("Execution error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}, { port: PORT });

console.log(`✅ Deno Runtime listening on port ${PORT}`);
