/**
 * Integration tests for function-loader app_env_vars merge (Task 4).
 *
 * Prerequisites:
 *   CONTROL_PLANE_URL — points to the runtime DB (or test DB)
 *   AUTH_ENCRYPTION_KEY — 64 hex chars AES-256 key
 *
 * Run:
 *   deno test --allow-env --allow-net function-loader.test.ts
 */

import { describe, it, beforeAll, afterAll, afterEach } from "jsr:@std/testing/bdd";
import { expect } from "jsr:@std/expect";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

import { loadFunction, invalidateCache } from "./function-loader.ts";
import { encrypt } from "./crypto.ts";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const ENCRYPTION_KEY = Deno.env.get("AUTH_ENCRYPTION_KEY")!;
if (!ENCRYPTION_KEY) {
  throw new Error("AUTH_ENCRYPTION_KEY env var is required for function-loader tests");
}

const DB_URL = Deno.env.get("CONTROL_PLANE_URL")!;
if (!DB_URL) {
  throw new Error("CONTROL_PLANE_URL env var is required for function-loader tests");
}

// A fixed app_id prefix for test isolation — unique per test run to avoid
// collisions when tests are run concurrently.
const TEST_PREFIX = `test_fl_${Date.now()}`;
const appId = `${TEST_PREFIX}_app`;

let db: Client;

// Seed a row in app_functions. env=null means no encrypted_env_vars.
async function seedFunction(
  aid: string,
  name: string,
  opts: { code?: string; env: Record<string, string> | null }
): Promise<void> {
  const code = opts.code ?? "export default () => ({})";
  if (opts.env !== null) {
    const enc = encrypt(JSON.stringify(opts.env), ENCRYPTION_KEY);
    await db.queryObject(
      `INSERT INTO app_functions (app_id, name, code, encrypted_env_vars)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [aid, name, code, enc]
    );
  } else {
    await db.queryObject(
      `INSERT INTO app_functions (app_id, name, code)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [aid, name, code]
    );
  }
}

// Seed (or upsert) a row in app_env_vars.
async function seedAppEnv(
  aid: string,
  vars: Record<string, string>
): Promise<void> {
  const enc = encrypt(JSON.stringify(vars), ENCRYPTION_KEY);
  await db.queryObject(
    `INSERT INTO app_env_vars (app_id, encrypted_env_vars) VALUES ($1, $2)
     ON CONFLICT (app_id) DO UPDATE SET encrypted_env_vars = EXCLUDED.encrypted_env_vars`,
    [aid, enc]
  );
}

// Wipe all test rows inserted by this run.
async function cleanup(): Promise<void> {
  await db.queryObject(`DELETE FROM app_env_vars   WHERE app_id = $1`, [appId]);
  await db.queryObject(`DELETE FROM app_functions  WHERE app_id = $1`, [appId]);
  invalidateCache(appId, "hello");
}

// ---------------------------------------------------------------------------
// Precedence tests
// ---------------------------------------------------------------------------

// sanitizeResources/sanitizeOps are false because function-loader.ts keeps a
// module-level connection Pool open for its lifetime (by design — it's a
// server process). The test DB client is explicitly closed in afterAll.
describe(
  {
    name: "app-level env var merge",
    sanitizeResources: false,
    sanitizeOps: false,
  },
  () => {
  beforeAll(async () => {
    db = new Client(DB_URL);
    await db.connect();

    // Ensure there is an apps row and an app_db_connections row so
    // function-loader can proceed past the "app not found" and
    // "no db connection" guards.
    await db.queryObject(
      `INSERT INTO apps (id, name, owner_id, db_name, db_provisioned)
       VALUES ($1, $1, gen_random_uuid(), $1, true)
       ON CONFLICT (id) DO NOTHING`,
      [appId]
    );
    await db.queryObject(
      `INSERT INTO app_db_connections (app_id, connection_string)
       VALUES ($1, 'postgresql://test:test@localhost/test')
       ON CONFLICT (app_id) DO NOTHING`,
      [appId]
    );
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    // Clean up static fixture rows seeded in beforeAll.
    await db.queryObject(`DELETE FROM app_db_connections WHERE app_id = $1`, [appId]);
    await db.queryObject(`DELETE FROM apps WHERE id = $1`, [appId]);
    await db.end();
  });

  it("app-level only: appears in ctx.env", async () => {
    await seedAppEnv(appId, { STRIPE_SECRET: "sk_app" });
    await seedFunction(appId, "hello", { code: "export default () => ({})", env: null });
    const md = await loadFunction(appId, "hello");
    expect(md!.env_vars.STRIPE_SECRET).toBe("sk_app");
  });

  it("function-level wins over app-level on collision", async () => {
    await seedAppEnv(appId, { STRIPE_SECRET: "sk_app", SHARED: "a" });
    await seedFunction(appId, "hello", { code: "export default () => ({})", env: { STRIPE_SECRET: "sk_fn" } });
    const md = await loadFunction(appId, "hello");
    expect(md!.env_vars.STRIPE_SECRET).toBe("sk_fn");
    expect(md!.env_vars.SHARED).toBe("a");
  });

  it("no app row: falls back to function env only", async () => {
    await seedFunction(appId, "hello", { code: "export default () => ({})", env: { X: "1" } });
    const md = await loadFunction(appId, "hello");
    expect(md!.env_vars).toEqual({ X: "1" });
  });

  it("neither row has env: env_vars is {}", async () => {
    await seedFunction(appId, "hello", { code: "export default () => ({})", env: null });
    const md = await loadFunction(appId, "hello");
    expect(md!.env_vars).toEqual({});
  });
});
