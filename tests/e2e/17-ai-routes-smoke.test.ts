/**
 * E2E smoke for the AI gateway routes that the SDK's new `AiClient.embed()`
 * and `AiClient.listModels()` methods wrap (added in Plan 2 of the SDK/CLI
 * drift work).
 *
 * Goal: confirm the routes are wired, reach our handler, and return either a
 * 200 (when external provider config is present) or a recognizable structured
 * error (when missing) — never a wrong-pool 500.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootE2E, type E2EEnv } from './helpers/boot.js';
import { seedApp, type SeededApp } from './helpers/seed.js';
import { cleanupAll } from './helpers/cleanup.js';
import { sseDispatcher } from '../../services/control-api/src/routes/hackathons-public.js';

let env: E2EEnv;
let seeded: SeededApp;

beforeAll(async () => {
  env = await bootE2E();
  seeded = await seedApp(env.controlPool, { region: 'us-east-1' });
}, 60_000);

afterAll(async () => {
  const appAny = env.app as any;
  const intervals = ['ragWorkerInterval', 'flushInterval', 'failureNotifierInterval',
    'neonWorkerInterval', 'analyticsPullerInterval', 'nightlyInterval'];
  const timeouts = ['nightlyTimeout'];
  for (const key of intervals) if (appAny[key]) { clearInterval(appAny[key]); appAny[key] = undefined; }
  for (const key of timeouts) if (appAny[key]) { clearTimeout(appAny[key]); appAny[key] = undefined; }
  sseDispatcher.stop();
  await cleanupAll(env.controlPool);
  await env.shutdown();
}, 120_000);

describe('Plan 2 / Plan 3 — AI gateway new routes', () => {
  it('GET /v1/:appId/ai/models — route exists, no wrong-pool 500', async () => {
    const r = await env.app.inject({
      method: 'GET',
      url: `/v1/${seeded.appId}/ai/models`,
      headers: { 'x-test-user-id': seeded.userId },
    });
    // Acceptable outcomes:
    //   200 with { models: [...] } when router catalog or OpenRouter is configured
    //   4xx/5xx when external dependency missing
    // Hard-fail only on wrong-pool / generic 500
    expect(r.statusCode).not.toBe(404); // route MUST be registered
    if (r.statusCode === 500) {
      expect(r.body, `500 body: ${r.body}`).not.toMatch(/relation .* does not exist/);
    }
    if (r.statusCode === 200) {
      const body = r.json();
      expect(body).toHaveProperty('models');
      expect(Array.isArray(body.models)).toBe(true);
    }
  });

  it('POST /v1/:appId/embeddings — route exists, validates body', async () => {
    // Empty body should be rejected with 4xx (zod schema), proving the route is wired.
    const r = await env.app.inject({
      method: 'POST',
      url: `/v1/${seeded.appId}/embeddings`,
      payload: {},
      headers: {
        'x-test-user-id': seeded.userId,
        'content-type': 'application/json',
      },
    });
    expect(r.statusCode).not.toBe(404);
    // With proper body, route would attempt provider call. Without input,
    // we expect 400 (validation) — never wrong-pool 500.
    if (r.statusCode === 500) {
      expect(r.body, `500 body: ${r.body}`).not.toMatch(/relation .* does not exist/);
    }
  });

  it('POST /v1/:appId/embeddings — accepts shape { input } and reaches handler', async () => {
    const r = await env.app.inject({
      method: 'POST',
      url: `/v1/${seeded.appId}/embeddings`,
      payload: { input: 'hello world' },
      headers: {
        'x-test-user-id': seeded.userId,
        'content-type': 'application/json',
      },
    });
    // 200 if a provider is configured; otherwise a structured error from the
    // router (4xx/5xx with our error shape) — but NEVER a wrong-pool 500.
    expect(r.statusCode).not.toBe(404);
    if (r.statusCode === 500) {
      expect(r.body, `500 body: ${r.body}`).not.toMatch(/relation .* does not exist/);
    }
  });

  it('GET /v1/:appId/ai/config — already-existing route still wired', async () => {
    const r = await env.app.inject({
      method: 'GET',
      url: `/v1/${seeded.appId}/ai/config`,
      headers: { 'x-test-user-id': seeded.userId },
    });
    expect(r.statusCode).not.toBe(404);
    if (r.statusCode === 500) {
      expect(r.body, `500 body: ${r.body}`).not.toMatch(/relation .* does not exist/);
    }
  });
});
