// Uses actual executeFunction -> generated Worker -> echo handler and cached
// mocked PostgreSQL import. Null DB metadata ensures no pool/connection is made.
import { buildWorkerCode, executeFunction } from "../worker-executor.ts";
import type { ExecutionResult } from "../worker-executor.ts";
import type { FunctionMetadata } from "../function-loader.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const metadata = {
  id: "fn_bytes_test",
  app_id: "app_bytes_test",
  name: "echo",
  function_name: "echo",
  code: `async function handler(request) {
    const hasBody = request.body !== null;
    const bytes = hasBody ? new Uint8Array(await request.arrayBuffer()) : null;
    return new Response(bytes, { headers: {
      "x-observed-method": request.method,
      "x-observed-content-type": request.headers.get("content-type") || "absent",
      "x-observed-marker": request.headers.get("x-marker") || "absent",
      "x-observed-body": String(hasBody),
    }});
  }`,
  env_vars: {},
  internal_fn_key: null,
  timeout_ms: 10000,
  memory_limit_mb: 128,
  allow_service_key_impersonation: true,
  db_connection_string: null,
  substrate_organization_id: null,
  platform: {
    app_name: "bytes-test", owner_id: "user_test", region: "test",
    subdomain: null, frontend_url: null, anon_key: "fake-anon",
    allowed_origins: [], stripe_connect_account_id: null, ai_default_model: null,
    jwt_access_token_ttl: null, jwt_refresh_token_ttl_days: null, auth_hook_function: null,
  },
} as FunctionMetadata;

function assertBytes(result: ExecutionResult, expected: Uint8Array) {
  assert(result.success && result.response, "echo handler failed: " + result.error?.message);
  const actual = atob(result.response.bodyBase64);
  assert(actual.length === expected.length, `byte count changed: ${actual.length} vs ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    assert(actual.charCodeAt(i) === expected[i], `request byte changed at offset ${i}`);
  }
}

const encoder = new TextEncoder();
const largeBody = new Uint8Array(1024 * 1024);
for (let i = 0; i < largeBody.length; i++) largeBody[i] = i % 256;
const byteCases: Array<[string, Uint8Array]> = [
  ["leading UTF-8 BOM", new Uint8Array([0xef, 0xbb, 0xbf, 0x41])],
  ["supplementary and combining Unicode", encoder.encode("中文 😀 𝄞 e\u0301")],
  ["CRLF", encoder.encode("first\r\nsecond\r\n")],
  ["invalid UTF-8", new Uint8Array([0x61, 0xc3, 0x28, 0xff, 0x80, 0x62])],
  ["binary including NUL", new Uint8Array([0, 1, 0x7f, 0x80, 0xfe, 0xff, 0])],
  ["one MiB binary", largeBody],
  ["empty present body", new Uint8Array(0)],
];

for (const [label, bytes] of byteCases) {
  Deno.test(`executeFunction preserves ${label} through the real worker`, async () => {
    const result = await executeFunction(metadata, new Request("http://runtime.invalid/execute/test", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-marker": "test-marker" },
      body: new Uint8Array(bytes),
    }));
    // executeFunction resolves before the worker's final done notification.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertBytes(result, bytes);
    assert(result.response!.headers["x-observed-method"] === "POST", "method changed");
    assert(result.response!.headers["x-observed-content-type"] === "application/octet-stream", "content type changed");
    assert(result.response!.headers["x-observed-marker"] === "test-marker", "custom header changed");
    assert(result.response!.headers["x-observed-body"] === "true", "present body was removed");
  });
}

for (const method of ["GET", "HEAD", "POST"]) {
  Deno.test(`executeFunction preserves absent body for ${method}`, async () => {
    const result = await executeFunction(metadata, new Request("http://runtime.invalid/execute/test", { method }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertBytes(result, new Uint8Array(0));
    assert(result.response!.headers["x-observed-method"] === method, "method changed");
    assert(result.response!.headers["x-observed-body"] === "false", "absent body was synthesized");
    assert(result.response!.headers["x-observed-content-type"] === "absent", "content type was synthesized");
  });
}

Deno.test("executeFunction preserves PUT bytes without synthesizing a content type", async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0x00]);
  const result = await executeFunction(metadata, new Request("http://runtime.invalid/execute/test", {
    method: "PUT", body: bytes,
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertBytes(result, bytes);
  assert(result.response!.headers["x-observed-method"] === "PUT", "method changed");
  assert(result.response!.headers["x-observed-content-type"] === "absent", "content type was synthesized");
});

for (const [label, text] of [
  ["Unicode", "\uFEFFlegacy 😀 e\u0301\r\nstring"],
  ["code-like content", "\0\"; throw new Error(\"body escaped\"); // ` ${globalThis} \\ \u2028\u2029"],
  ["empty string absence", ""],
] as const) {
Deno.test(`buildWorkerCode retains legacy string callers: ${label}`, async () => {
  const code = buildWorkerCode(metadata, {
    dbUrl: "", requestUrl: "http://runtime.invalid/legacy", requestMethod: "POST",
    requestHeaders: { "content-type": "text/plain" }, requestBody: text,
  });
  const url = URL.createObjectURL(new Blob([code], { type: "application/typescript" }));
  const worker = new Worker(url, { type: "module" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await new Promise<ExecutionResult["response"]>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("legacy worker timeout")), 10000);
      worker.onmessage = (event) => {
        if (event.data.type === "success") resolve(event.data.response);
        if (event.data.type === "error") reject(new Error(event.data.error.message));
      };
      worker.onerror = (event) => reject(new Error(event.message));
    });
    assertBytes({ success: true, response, logs: [], metrics: { duration_ms: 0, memory_used_mb: 0 } }, encoder.encode(text));
    assert(response!.headers["x-observed-body"] === String(Boolean(text)), "legacy empty/string body presence changed");
  } finally {
    clearTimeout(timer);
    worker.terminate();
    URL.revokeObjectURL(url);
  }
});

}
