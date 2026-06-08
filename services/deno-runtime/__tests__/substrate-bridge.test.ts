/**
 * Integration tests for ctx.substrate worker injection (Task 6, Substrate Phase 3).
 *
 * SKIP RATIONALE: executeFunction() spawns a Deno Web Worker using
 *   new Worker(URL.createObjectURL(...), { type: "module", deno: { permissions: ... } })
 * and the module itself calls Deno.env.get() at import time. Both of these APIs
 * are Deno-only and are not available in Node / vitest. These tests are authored
 * to document the expected behaviour and can be exercised by running the Deno
 * test suite once a Deno-compatible test harness is wired up.
 *
 * TODO: run when Deno is available. Suggested command from repo root:
 *   deno test --allow-env --allow-net \
 *     submodules/butterbase-oss/services/deno-runtime/__tests__/substrate-bridge.test.ts
 *
 * When un-skipping, replace the vitest imports with the Deno std/testing equivalents:
 *   import { describe, it, beforeAll, afterAll } from "https://deno.land/std/testing/bdd.ts";
 *   import { expect } from "https://deno.land/std/expect/mod.ts";
 * and replace the Fastify fake server with an std/http server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// NOTE: the import below will fail under Node because worker-executor.ts calls
// Deno.env.get() at module scope. The entire describe block is skipped so the
// import error never surfaces during normal vitest runs.
// import { executeFunction, type ExecutionResult } from '../worker-executor.js';
import type { FunctionMetadata } from '../function-loader.js';

// ---------------------------------------------------------------------------
// Fake control-api fixture
// ---------------------------------------------------------------------------
// In a real Deno run we would use Deno.serve({ port: 0 }). Under vitest we
// declare the shape here as documentation and the tests are all skipped.

/** Recorded inbound requests to the fake /internal/substrate/…/propose endpoint */
const hits: Array<{ params: Record<string, string>; headers: Record<string, string>; body: any }> = [];

// Minimal metadata stub that satisfies FunctionMetadata (cast as any to avoid
// importing the Deno-module-level type at runtime).
function makeMetadata(overrides: Partial<FunctionMetadata> & { code: string }): any {
  return {
    id: 'fn_test',
    app_id: 'app_under_test',
    name: 'test-fn',          // used by reconstructPublicUrl in worker-executor
    function_name: 'test-fn',
    env_vars: {},
    timeout_ms: 10_000,
    memory_limit_mb: 128,
    db_connection_string: null,
    substrate_user_id: null,
    ...overrides,
  } satisfies any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worker ctx.substrate bridge', () => {
  // -------------------------------------------------------------------------
  it.skip(
    // TODO: run when Deno is available
    'routes propose() through the internal bridge to control-api',
    async () => {
      // Set up env before importing executeFunction so Deno.env.get picks it up.
      const apiUrl = 'http://127.0.0.1:__PORT__'; // replace __PORT__ with dynamic port
      process.env.CONTROL_API_URL = apiUrl;
      process.env.BUTTERBASE_INTERNAL_SECRET = 'phase3-test-secret';

      // Dynamically import to avoid Deno.env.get at module scope under Node.
      const { executeFunction } = await import('../worker-executor.js' as any);

      const metadata = makeMetadata({
        app_id: 'app_under_test',
        substrate_user_id: '00000000-0000-0000-0000-0000000bb301',
        code: `
          export default async (_req, ctx) => {
            const r = await ctx.substrate.propose('upsert_entity', {
              type: 'person',
              display_name: 'WorkerTest',
            });
            return new Response(JSON.stringify(r));
          };
        `,
      });

      const result: any = await executeFunction(
        metadata,
        new Request('http://localhost/test'),
        'caller-user-id',
      );

      // Worker returned a success result
      expect(result.success).toBe(true);
      expect(result.response).toBeDefined();

      // Decode base64 body
      const body = JSON.parse(atob(result.response!.bodyBase64));
      expect(body.action_id).toBe('act_fake_1');

      // Fake server received exactly one call
      expect(hits).toHaveLength(1);
      expect(hits[0].params.app_id).toBe('app_under_test');
      expect(hits[0].headers['x-butterbase-internal-secret']).toBe('phase3-test-secret');
      expect(hits[0].body.capability).toBe('upsert_entity');
      expect(hits[0].body.payload.display_name).toBe('WorkerTest');
    },
  );

  // -------------------------------------------------------------------------
  it.skip(
    // TODO: run when Deno is available
    'does not inject ctx.substrate when metadata.substrate_user_id is null',
    async () => {
      hits.length = 0;

      const { executeFunction } = await import('../worker-executor.js' as any);

      const metadata = makeMetadata({
        app_id: 'app_unlinked',
        substrate_user_id: null,
        code: `
          export default async (_req, ctx) => {
            return new Response(JSON.stringify({ hasSubstrate: !!ctx.substrate }));
          };
        `,
      });

      const result: any = await executeFunction(
        metadata,
        new Request('http://localhost/test'),
        'caller',
      );

      expect(result.success).toBe(true);

      const body = JSON.parse(atob(result.response!.bodyBase64));
      expect(body.hasSubstrate).toBe(false);

      // No calls forwarded to the fake control-api
      expect(hits).toHaveLength(0);
    },
  );

  // -------------------------------------------------------------------------
  it.skip(
    // TODO: run when Deno is available
    'forwards idempotency_key when provided to propose()',
    async () => {
      hits.length = 0;
      process.env.CONTROL_API_URL = 'http://127.0.0.1:__PORT__';
      process.env.BUTTERBASE_INTERNAL_SECRET = 'phase3-test-secret';

      const { executeFunction } = await import('../worker-executor.js' as any);

      const metadata = makeMetadata({
        app_id: 'app_idem',
        substrate_user_id: '00000000-0000-0000-0000-000000001234',
        code: `
          export default async (_req, ctx) => {
            const r = await ctx.substrate.propose(
              'upsert_entity',
              { type: 'person', display_name: 'IdemTest' },
              { idempotency_key: 'idem-key-abc' },
            );
            return new Response(JSON.stringify(r));
          };
        `,
      });

      await executeFunction(metadata, new Request('http://localhost/test'), 'caller');

      expect(hits).toHaveLength(1);
      expect(hits[0].body.idempotency_key).toBe('idem-key-abc');
    },
  );

  // -------------------------------------------------------------------------
  it.skip(
    // TODO: run when Deno is available
    'throws inside the worker when propose() receives a non-2xx response',
    async () => {
      hits.length = 0;
      // Point at a URL that returns 500
      process.env.CONTROL_API_URL = 'http://127.0.0.1:__ERROR_PORT__';
      process.env.BUTTERBASE_INTERNAL_SECRET = 'phase3-test-secret';

      const { executeFunction } = await import('../worker-executor.js' as any);

      const metadata = makeMetadata({
        app_id: 'app_err',
        substrate_user_id: '00000000-0000-0000-0000-000000001234',
        code: `
          export default async (_req, ctx) => {
            await ctx.substrate.propose('upsert_entity', { type: 'person' });
            return new Response('ok');
          };
        `,
      });

      const result: any = await executeFunction(
        metadata,
        new Request('http://localhost/test'),
        'caller',
      );

      // Worker should surface the propose error
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/substrate\.propose failed/);
    },
  );
});
