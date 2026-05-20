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

describe('Phase 5 — /v1/internal/active-migrations', () => {
  it('returns by_step + by_region_pair + active_source_replicas', async () => {
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });
    await env.controlPool.query(
      `INSERT INTO app_migrations (id, app_id, user_id, source_region, dest_region, current_step)
       VALUES (gen_random_uuid(), $1, $2, 'us-east-1', 'eu-west-1', 'dumping_data')`,
      [seeded.appId, seeded.userId],
    );

    const r = await env.app.inject({
      method: 'GET', url: '/v1/internal/active-migrations',
      headers: { 'x-butterbase-internal-secret': process.env.BUTTERBASE_INTERNAL_SECRET! },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.by_step.some((x: any) => x.current_step === 'dumping_data')).toBe(true);
    expect(body.by_region_pair.some((x: any) => x.region_pair.includes('us-east-1'))).toBe(true);
  });

  it('401 without internal secret', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/v1/internal/active-migrations' });
    expect(r.statusCode).toBe(401);
  });
});
