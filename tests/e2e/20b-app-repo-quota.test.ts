/**
 * E2E — Phase 5 D1: per-app repo total quota via storage_config.total_size_limit
 *
 * Covers:
 *   1. 413 storage_quota_exceeded when manifest_bytes + current_bytes > total_size_limit.
 *   2. 200 when manifest_bytes + current_bytes <= total_size_limit.
 *   3. No limit enforced when storage_config.total_size_limit is absent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { bootE2E, type E2EEnv, runtimePoolFor } from './helpers/boot.js';
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

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('Phase 5 D1 — repo storage_config quota', () => {
  it('returns 413 storage_quota_exceeded when manifest_bytes exceeds total_size_limit', async () => {
    const { userId, appId, region } = await seedApp(env.controlPool, {
      region: 'us-east-1',
      emailPrefix: 'repo-quota-exceed',
    });

    // Set total_size_limit to 1024 bytes — smaller than the manifest we'll send.
    const runtimePool = runtimePoolFor(region);
    await runtimePool.query(
      `UPDATE apps SET storage_config = jsonb_set(COALESCE(storage_config, '{}'::jsonb), '{total_size_limit}', '1024'::jsonb) WHERE id = $1`,
      [appId],
    );

    // Prepare with 2000 bytes — exceeds the 1024 limit.
    const manifest = {
      files: [{ path: 'big.txt', sha256: sha256('a'.repeat(2000)), size: 2000 }],
    };

    const res = await env.app.inject({
      method: 'POST',
      url: `/v1/${appId}/repo/snapshots/prepare`,
      headers: { 'x-test-user-id': userId },
      payload: manifest,
    });

    expect(res.statusCode).toBe(413);
    const body = res.json() as any;
    expect(body.error).toBe('storage_quota_exceeded');
    expect(body.limit_bytes).toBe(1024);
    expect(body.manifest_bytes).toBe(2000);
    expect(typeof body.current_bytes).toBe('number');
  });

  it('allows prepare when manifest_bytes is within total_size_limit', async () => {
    const { userId, appId, region } = await seedApp(env.controlPool, {
      region: 'us-east-1',
      emailPrefix: 'repo-quota-ok',
    });

    // Set a generous quota — 10000 bytes.
    const runtimePool = runtimePoolFor(region);
    await runtimePool.query(
      `UPDATE apps SET storage_config = jsonb_set(COALESCE(storage_config, '{}'::jsonb), '{total_size_limit}', '10000'::jsonb) WHERE id = $1`,
      [appId],
    );

    // Prepare with 500 bytes — well under the limit.
    const manifest = {
      files: [{ path: 'small.txt', sha256: sha256('b'.repeat(500)), size: 500 }],
    };

    const res = await env.app.inject({
      method: 'POST',
      url: `/v1/${appId}/repo/snapshots/prepare`,
      headers: { 'x-test-user-id': userId },
      payload: manifest,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.snapshot_id).toBeDefined();
  });

  it('applies no quota when storage_config.total_size_limit is absent', async () => {
    const { userId, appId } = await seedApp(env.controlPool, {
      region: 'us-east-1',
      emailPrefix: 'repo-quota-none',
    });

    // Explicitly set storage_config to an object without total_size_limit.
    const runtimePool = runtimePoolFor('us-east-1');
    await runtimePool.query(
      `UPDATE apps SET storage_config = '{}'::jsonb WHERE id = $1`,
      [appId],
    );

    const manifest = {
      files: [{ path: 'any.txt', sha256: sha256('c'.repeat(1000)), size: 1000 }],
    };

    const res = await env.app.inject({
      method: 'POST',
      url: `/v1/${appId}/repo/snapshots/prepare`,
      headers: { 'x-test-user-id': userId },
      payload: manifest,
    });

    expect(res.statusCode).toBe(200);
  });
});
