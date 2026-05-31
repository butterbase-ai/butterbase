/**
 * E2E — PATCH /v1/:app_id/config/visibility + GET /v1/:app_id/config field projection
 *
 * Covers:
 *   1. After seedApp, GET /v1/:app_id/config returns the five new visibility
 *      fields at their defaults (visibility='private', listed=true,
 *      template_source_app_id=null, repo_latest_snapshot=null, fork_count=0).
 *   2. Owner PATCH { visibility: 'public' } → 200, subsequent GET reflects it.
 *   3. Owner PATCH { visibility: 'public', listed: false } → 200 with listed=false.
 *   4. Owner PATCH { visibility: 'private' } → 200, round-trip confirmed.
 *   5. Invalid body { visibility: 'secret' } → 400.
 *   6. Non-owner PATCH → 404 (existence must not leak).
 *   7. PATCH on nonexistent app_id → 404.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootE2E, type E2EEnv } from './helpers/boot.js';
import { seedApp } from './helpers/seed.js';
import { cleanupAll } from './helpers/cleanup.js';
import { sseDispatcher } from '../../services/control-api/src/routes/hackathons-public.js';

let env: E2EEnv;

beforeAll(async () => {
  env = await bootE2E();
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

describe('App visibility — PATCH /v1/:app_id/config/visibility', () => {
  it('GET /v1/:app_id/config returns visibility fields at defaults after seedApp', async () => {
    const a = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'visibility-defaults' });

    const r = await env.app.inject({
      method: 'GET',
      url: `/v1/${a.appId}/config`,
      headers: { 'x-test-user-id': a.userId },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json() as Record<string, unknown>;
    expect(body.visibility).toBe('private');
    expect(body.listed).toBe(true);
    expect(body.template_source_app_id).toBeNull();
    expect(body.repo_latest_snapshot).toBeNull();
    expect(body.fork_count).toBe(0);
  });

  it('owner PATCH { visibility: "public" } returns 200 and GET reflects the change', async () => {
    const a = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'visibility-public' });

    const patch = await env.app.inject({
      method: 'PATCH',
      url: `/v1/${a.appId}/config/visibility`,
      headers: { 'x-test-user-id': a.userId },
      payload: { visibility: 'public' },
    });

    expect(patch.statusCode).toBe(200);
    const patchBody = patch.json() as Record<string, unknown>;
    expect(patchBody.app_id).toBe(a.appId);
    expect(patchBody.visibility).toBe('public');
    expect(patchBody.listed).toBe(true);
    expect(typeof patchBody.message).toBe('string');

    const get = await env.app.inject({
      method: 'GET',
      url: `/v1/${a.appId}/config`,
      headers: { 'x-test-user-id': a.userId },
    });
    expect(get.statusCode).toBe(200);
    const getBody = get.json() as Record<string, unknown>;
    expect(getBody.visibility).toBe('public');
  });

  it('owner PATCH { visibility: "public", listed: false } returns 200 with listed=false', async () => {
    const a = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'visibility-unlisted' });

    const patch = await env.app.inject({
      method: 'PATCH',
      url: `/v1/${a.appId}/config/visibility`,
      headers: { 'x-test-user-id': a.userId },
      payload: { visibility: 'public', listed: false },
    });

    expect(patch.statusCode).toBe(200);
    const patchBody = patch.json() as Record<string, unknown>;
    expect(patchBody.visibility).toBe('public');
    expect(patchBody.listed).toBe(false);
  });

  it('owner PATCH { visibility: "private" } returns 200 and round-trip confirms private', async () => {
    const a = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'visibility-back-private' });

    // First make it public
    await env.app.inject({
      method: 'PATCH',
      url: `/v1/${a.appId}/config/visibility`,
      headers: { 'x-test-user-id': a.userId },
      payload: { visibility: 'public' },
    });

    // Then revert to private
    const patch = await env.app.inject({
      method: 'PATCH',
      url: `/v1/${a.appId}/config/visibility`,
      headers: { 'x-test-user-id': a.userId },
      payload: { visibility: 'private' },
    });

    expect(patch.statusCode).toBe(200);
    const patchBody = patch.json() as Record<string, unknown>;
    expect(patchBody.visibility).toBe('private');

    const get = await env.app.inject({
      method: 'GET',
      url: `/v1/${a.appId}/config`,
      headers: { 'x-test-user-id': a.userId },
    });
    expect(get.statusCode).toBe(200);
    const getBody = get.json() as Record<string, unknown>;
    expect(getBody.visibility).toBe('private');
  });

  it('PATCH with invalid visibility value returns 400', async () => {
    const a = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'visibility-invalid' });

    const patch = await env.app.inject({
      method: 'PATCH',
      url: `/v1/${a.appId}/config/visibility`,
      headers: { 'x-test-user-id': a.userId },
      payload: { visibility: 'secret' },
    });

    expect(patch.statusCode).toBe(400);
  });

  it('non-owner PATCH returns 404 (existence must not leak)', async () => {
    const owner = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'visibility-owner' });
    const other = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'visibility-other' });

    const patch = await env.app.inject({
      method: 'PATCH',
      url: `/v1/${owner.appId}/config/visibility`,
      headers: { 'x-test-user-id': other.userId },
      payload: { visibility: 'public' },
    });

    expect(patch.statusCode).toBe(404);
  });

  it('PATCH on nonexistent app_id returns 404', async () => {
    const a = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'visibility-ghost' });

    const patch = await env.app.inject({
      method: 'PATCH',
      url: `/v1/nonexistent-app-id-that-does-not-exist/config/visibility`,
      headers: { 'x-test-user-id': a.userId },
      payload: { visibility: 'public' },
    });

    expect(patch.statusCode).toBe(404);
  });

  it('persists listed=false across private → public flips', async () => {
    const a = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'visibility-listed-persistence' });

    // Set to public with listed=false
    const patch1 = await env.app.inject({
      method: 'PATCH',
      url: `/v1/${a.appId}/config/visibility`,
      headers: { 'x-test-user-id': a.userId },
      payload: { visibility: 'public', listed: false },
    });

    expect(patch1.statusCode).toBe(200);
    const body1 = patch1.json() as Record<string, unknown>;
    expect(body1.listed).toBe(false);

    // Flip to private (listed should persist)
    const patch2 = await env.app.inject({
      method: 'PATCH',
      url: `/v1/${a.appId}/config/visibility`,
      headers: { 'x-test-user-id': a.userId },
      payload: { visibility: 'private' },
    });

    expect(patch2.statusCode).toBe(200);

    // Flip back to public (listed should still be false)
    const patch3 = await env.app.inject({
      method: 'PATCH',
      url: `/v1/${a.appId}/config/visibility`,
      headers: { 'x-test-user-id': a.userId },
      payload: { visibility: 'public' },
    });

    expect(patch3.statusCode).toBe(200);
    const body3 = patch3.json() as Record<string, unknown>;
    expect(body3.listed).toBe(false);

    // Sanity check: GET /v1/:app_id/config confirms listed is still false
    const get = await env.app.inject({
      method: 'GET',
      url: `/v1/${a.appId}/config`,
      headers: { 'x-test-user-id': a.userId },
    });

    expect(get.statusCode).toBe(200);
    const getBody = get.json() as Record<string, unknown>;
    expect(getBody.listed).toBe(false);
  });
});
