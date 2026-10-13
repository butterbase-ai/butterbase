/**
 * Integration tests: deno-runtime refuses to load functions of a paused app.
 *
 * Needs CONTROL_PLANE_URL (a runtime-schema DB) and AUTH_ENCRYPTION_KEY, like
 * function-loader.test.ts.
 *
 * Run (from services/deno-runtime):
 *   deno test --allow-env --allow-net __tests__/paused-app.test.ts
 */
import { describe, it, beforeAll, afterAll } from "jsr:@std/testing/bdd";
import { expect } from "jsr:@std/expect";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

import { loadFunction, invalidateCache, AppPausedError } from "../function-loader.ts";

const DB_URL = Deno.env.get("CONTROL_PLANE_URL")!;
if (!DB_URL) {
  throw new Error("CONTROL_PLANE_URL env var is required for paused-app tests");
}
if (!Deno.env.get("AUTH_ENCRYPTION_KEY")) {
  throw new Error("AUTH_ENCRYPTION_KEY env var is required for paused-app tests");
}

const APP_ID = `test_paused_${Date.now()}_app`;
const FN = "hello";
const FN2 = "hello2";

let db: Client;

// sanitize* off: function-loader.ts keeps a module-level Pool open by design.
describe(
  { name: "paused apps", sanitizeResources: false, sanitizeOps: false },
  () => {
    beforeAll(async () => {
      db = new Client(DB_URL);
      await db.connect();
      await db.queryObject(
        `INSERT INTO apps (id, name, owner_id, db_name, db_provisioned, paused)
         VALUES ($1, $1, gen_random_uuid(), $1, true, false)`,
        [APP_ID],
      );
      await db.queryObject(
        `INSERT INTO app_db_connections (app_id, connection_string)
         VALUES ($1, 'postgresql://test:test@localhost/test')`,
        [APP_ID],
      );
      for (const name of [FN, FN2]) {
        await db.queryObject(
          `INSERT INTO app_functions (app_id, name, code)
           VALUES ($1, $2, 'export default () => ({})')`,
          [APP_ID, name],
        );
      }
    });

    afterAll(async () => {
      invalidateCache(APP_ID, FN);
      invalidateCache(APP_ID, FN2);
      await db.queryObject(`DELETE FROM app_functions WHERE app_id = $1`, [APP_ID]);
      await db.queryObject(`DELETE FROM app_db_connections WHERE app_id = $1`, [APP_ID]);
      await db.queryObject(`DELETE FROM apps WHERE id = $1`, [APP_ID]);
      await db.end();
    });

    it("loads while running, then refuses on the cached path once paused", async () => {
      expect(await loadFunction(APP_ID, FN)).not.toBeNull(); // miss -> cached
      await db.queryObject(`UPDATE apps SET paused = true WHERE id = $1`, [APP_ID]);
      await expect(loadFunction(APP_ID, FN)).rejects.toBeInstanceOf(AppPausedError); // hit path
    });

    it("refuses on the miss path", async () => {
      // App is still paused from the previous test; FN2 was never cached.
      await expect(loadFunction(APP_ID, FN2)).rejects.toBeInstanceOf(AppPausedError);
    });

    it("loads again once resumed", async () => {
      await db.queryObject(`UPDATE apps SET paused = false WHERE id = $1`, [APP_ID]);
      expect(await loadFunction(APP_ID, FN2)).not.toBeNull();
    });
  },
);
