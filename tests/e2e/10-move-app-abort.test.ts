import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootE2E, type E2EEnv } from './helpers/boot.js';
import { seedApp } from './helpers/seed.js';
import { cleanupAll } from './helpers/cleanup.js';
import { sseDispatcher } from '../../services/control-api/src/routes/hackathons-public.js';

let env: E2EEnv;

beforeAll(async () => {
  env = await bootE2E({ withDriver: false });
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

describe('Phase 5 — abort pre-cutover', () => {
  it('initiate then abort: migration ends in aborted state', async () => {
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });
    const init = await env.app.inject({
      method: 'POST', url: `/v1/apps/${seeded.appId}/move`,
      payload: { dest_region: 'eu-west-1' },
      headers: { 'x-test-user-id': seeded.userId, 'content-type': 'application/json' },
    });
    expect(init.statusCode).toBe(202);
    const migrationId = init.json().migration_id;

    const abort = await env.app.inject({
      method: 'POST', url: `/v1/apps/${seeded.appId}/migrations/${migrationId}/abort`,
      headers: { 'x-test-user-id': seeded.userId },
    });
    expect(abort.statusCode).toBe(200);

    const row = await env.controlPool.query(
      `SELECT current_step FROM app_migrations WHERE id = $1`,
      [migrationId],
    );
    expect(row.rows[0].current_step).toBe('aborted');
  });

  it('cannot abort after flipping_routing (409)', async () => {
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });
    const init = await env.app.inject({
      method: 'POST', url: `/v1/apps/${seeded.appId}/move`,
      payload: { dest_region: 'eu-west-1' },
      headers: { 'x-test-user-id': seeded.userId, 'content-type': 'application/json' },
    });
    expect(init.statusCode).toBe(202);
    const migrationId = init.json().migration_id;

    // Force the row to a post-cutover state
    await env.controlPool.query(
      `UPDATE app_migrations SET current_step = 'flipping_routing' WHERE id = $1`,
      [migrationId],
    );

    const abort = await env.app.inject({
      method: 'POST', url: `/v1/apps/${seeded.appId}/migrations/${migrationId}/abort`,
      headers: { 'x-test-user-id': seeded.userId },
    });
    expect(abort.statusCode).toBe(409);
  });
});
