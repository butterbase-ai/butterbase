import type pg from 'pg';
import { runtimePoolFor, listRuntimeRegions } from '../../../services/control-api/src/services/runtime-pool-registry.js';
import { mockKv } from './mock-kv.js';

export async function cleanupAll(controlPool: pg.Pool): Promise<void> {
  // Find e2e users
  const u = await controlPool.query<{ id: string }>(
    `SELECT id FROM platform_users WHERE email LIKE 'e2e%@example.com' OR email LIKE 'fanout%@example.com'`,
  );
  const userIds = u.rows.map(r => r.id);

  if (userIds.length > 0) {
    await controlPool.query(`DELETE FROM app_migrations WHERE user_id = ANY($1)`, [userIds]);
    await controlPool.query(`DELETE FROM user_app_index WHERE user_id = ANY($1)`, [userIds]);
    await controlPool.query(`DELETE FROM subscriptions WHERE user_id = ANY($1)`, [userIds]).catch(()=>{});
    await controlPool.query(`DELETE FROM usage_meters WHERE user_id = ANY($1)`, [userIds]).catch(()=>{});
    await controlPool.query(`DELETE FROM neon_tasks WHERE app_id LIKE 'e2e-app-%'`).catch(()=>{});
  }
  await controlPool.query(`DELETE FROM platform_users WHERE email LIKE 'e2e%@example.com' OR email LIKE 'fanout%@example.com'`);

  for (const region of listRuntimeRegions()) {
    const r = runtimePoolFor(region);
    await r.query(`DELETE FROM apps WHERE id LIKE 'e2e-app-%'`);
  }
  mockKv.reset();
}
