// Run without network permission or credentials:
// CONTROL_PLANE_URL=postgres://unused/unused BUTTERBASE_REGION=test \
// NEON_RUNTIME_PROJECT_ID_TEST=postgres://unused/unused deno test --no-check \
//   --allow-env --cached-only --import-map=__tests__/invocation-logger.import-map.json \
//   __tests__/invocation-logger.test.ts
import { logInvocation } from "../invocation-logger.ts";
import type { FunctionMetadata } from "../function-loader.ts";
import type { ExecutionResult } from "../worker-executor.ts";
import { queries } from "./fixtures/capture-postgres.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const metadata = { id: "fn_header_test", app_id: "app_header_test" } as FunctionMetadata;
const result: ExecutionResult = {
  success: true,
  response: { status: 201, headers: {}, bodyBase64: "" },
  logs: [],
  metrics: { duration_ms: 101, memory_used_mb: 1.2 },
};

for (const callerType of ["end_user_jwt", "service_key"] as const) {
  Deno.test(`invocation insert excludes credentials for ${callerType} while retaining metadata`, async () => {
    queries.length = 0;
    const secrets = [
      "Bearer fake-end-user-bearer",
      "Bearer bb_sk_fake-app-scoped-service-key",
      "fake-proxy-bearer", "session=fake-cookie", "fake-set-cookie",
      "fake-api-key", "fake-internal-secret", "fake-custom-token", "fake-unknown-secret", "fake-asserted-identity", "fake-platform-origin",
    ];
    const request = new Request("https://runtime.invalid/functions/test?excluded=query", {
      method: "POST",
      headers: {
        aUtHoRiZaTiOn: callerType === "end_user_jwt" ? secrets[0] : secrets[1],
        "pRoXy-AuThOrIzAtIoN": secrets[2],
        cOoKiE: secrets[3],
        "sEt-CoOkIe": secrets[4],
        "X-Api-Key": secrets[5],
        "X-Butterbase-Internal-Secret": secrets[6],
        "X-Custom-Token": secrets[7],
        "Future-Credential": secrets[8],
        "X-Butterbase-As-User": "fake-asserted-identity",
        "X-Butterbase-Cron-Origin": "fake-platform-origin",
        "X-Forwarded-Authorization": secrets[0],
        "CoNtEnT-TyPe": "application/json",
        "CONTENT-LENGTH": "17",
        Accept: "application/json",
        "Content-Encoding": "gzip",
        "Accept-Encoding": "gzip, br",
      },
    });

    await logInvocation(metadata, request, result, "user_header_test", callerType);

    assert(queries.length === 2, "must insert invocation and update stats");
    const insert = queries[0];
    assert(insert.sql.includes("INSERT INTO function_invocations"), "must exercise invocation insert");
    const serialized = JSON.stringify(insert.args);
    for (const secret of secrets) {
      assert(!serialized.includes(secret), "credential value reached invocation insert");
    }
    const headers = JSON.parse(insert.args[6] as string);
    assert(JSON.stringify(headers) === JSON.stringify({
      "accept": "application/json",
      "accept-encoding": "gzip, br",
      "content-encoding": "gzip",
      "content-length": "17",
      "content-type": "application/json",
    }), "only allowlisted metadata may be persisted");
    assert(insert.args[0] === "fn_header_test" && insert.args[1] === "app_header_test", "function identity changed");
    assert(insert.args[2] === "user_header_test", "caller identity changed");
    assert(insert.args[3] === (callerType === "end_user_jwt" ? "user_header_test" : null), "end-user accounting changed");
    assert(insert.args[4] === "POST" && insert.args[5] === "/functions/test", "request metadata changed");
    assert(insert.args[7] === 17 && insert.args[8] === 201, "size or status changed");
    assert(insert.args[16] === 200 && insert.args[17] === 2, "billing rounding changed");
    assert(queries[1].sql.includes("invocation_count = invocation_count + 1"), "invocation count update removed");
    assert(JSON.stringify(queries[1].args) === '["fn_header_test",false,101,201]', "function stats changed");
  });
}

Deno.test("invocation insert omits all unknown headers and supports an empty header set", async () => {
  const cases: Record<string, string>[] = [{ "X-Unrecognized": "fake-secret" }, {}];
  for (const headers of cases) {
    queries.length = 0;
    await logInvocation(metadata, new Request("https://runtime.invalid/", { headers }), result);
    assert(queries.length === 2, "anonymous invocation must still be recorded");
    assert(queries[0].args[6] === "{}", "unknown header value must not be stored");
    assert(queries[0].args[2] === null && queries[0].args[3] === null, "anonymous identity changed");
  }
});

for (const [timeout, expectedStatus] of [[false, 500], [true, 504]] as const) {
  Deno.test(`redaction preserves failure status ${expectedStatus} and error accounting`, async () => {
    queries.length = 0;
    await logInvocation(metadata, new Request("https://runtime.invalid/", {
      headers: { Authorization: "Bearer fake-failed-invocation-secret" },
    }), {
      success: false,
      timeout,
      error: { message: "test handler failed" },
      logs: [],
      metrics: { duration_ms: 101, memory_used_mb: 1.2 },
    });
    assert(queries.length === 2, "failed invocation must still be recorded");
    assert(queries[0].args[6] === "{}", "failed invocation credential must not be stored");
    assert(queries[0].args[8] === expectedStatus, "failure status changed");
    assert(queries[0].args[12] === "test handler failed", "error metadata changed");
    assert(queries[0].args[16] === 200 && queries[0].args[17] === 2, "failure billing changed");
    assert(JSON.stringify(queries[1].args) === JSON.stringify(["fn_header_test", true, 101, expectedStatus]), "failure stats changed");
  });
}
