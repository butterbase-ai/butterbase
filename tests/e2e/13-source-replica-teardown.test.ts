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

describe('Phase 5 — source-replica list + teardown', () => {
  it('GET /v1/source-replicas lists active replicas', async () => {
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });
    await env.controlPool.query(
      `INSERT INTO app_migrations (id, app_id, user_id, source_region, dest_region, current_step, source_replica_state, completed_at)
       VALUES (gen_random_uuid(), $1, $2, 'us-east-1', 'eu-west-1', 'completed', 'replicating', now())`,
      [seeded.appId, seeded.userId],
    );

    const r = await env.app.inject({
      method: 'GET', url: '/v1/source-replicas',
      headers: { 'x-test-user-id': seeded.userId },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().source_replicas.length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE /v1/source-replicas/:id tears down + enqueues neon_tasks deprovision', async () => {
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });
    const m = await env.controlPool.query<{ id: string }>(
      `INSERT INTO app_migrations (id, app_id, user_id, source_region, dest_region, current_step, source_replica_state, completed_at)
       VALUES (gen_random_uuid(), $1, $2, 'us-east-1', 'eu-west-1', 'completed', 'replicating', now()) RETURNING id`,
      [seeded.appId, seeded.userId],
    );
    const mid = m.rows[0].id;

    const del = await env.app.inject({
      method: 'DELETE', url: `/v1/source-replicas/${mid}`,
      headers: { 'x-test-user-id': seeded.userId },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().status).toBe('torn_down');

    const state = await env.controlPool.query(
      `SELECT source_replica_state FROM app_migrations WHERE id = $1`,
      [mid],
    );
    expect(state.rows[0].source_replica_state).toBe('torn_down');

    const tasks = await env.controlPool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM neon_tasks WHERE task_type = 'deprovision' AND app_id = $1`,
      [seeded.appId],
    );
    expect(tasks.rows[0].c).toBeGreaterThanOrEqual(1);
  });
});
