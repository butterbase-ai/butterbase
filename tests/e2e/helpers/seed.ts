import type pg from 'pg';
import { runtimePoolFor } from '../../../services/control-api/src/services/runtime-pool-registry.js';
import { mockKv } from './mock-kv.js';

export interface SeededApp {
  userId: string;
  appId: string;
  subdomain: string;
  region: string;
  ownerEmail: string;
}

export async function seedApp(
  controlPool: pg.Pool,
  opts: { region: string; emailPrefix?: string },
): Promise<SeededApp> {
  const stamp = Date.now() + Math.random().toString(36).slice(2, 6);
  const ownerEmail = `${opts.emailPrefix ?? 'e2e'}-${stamp}@example.com`;
  const appId = `e2e-app-${stamp}`;
  const subdomain = `e2e-${stamp}`;

  const u = await controlPool.query<{ id: string }>(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES (gen_random_uuid(), $1, 'active', 'launch') RETURNING id`,
    [ownerEmail],
  );
  const userId = u.rows[0].id;

  await controlPool.query(
    `INSERT INTO org_app_index (app_id, organization_id, region) VALUES ($1, (SELECT personal_organization_id FROM platform_users WHERE id = $2), $3)`,
    [appId, userId, opts.region],
  );

  const runtime = runtimePoolFor(opts.region);
  // apps schema (001_initial_runtime_schema.sql):
  //   id, name, owner_id, db_name, region, subdomain, provisioning_status
  //   db_provisioned defaults false; anon_key has a default; allowed_origins, storage_config,
  //   jwt_config, ai_config all have defaults.
  await runtime.query(
    `INSERT INTO apps (id, name, owner_id, db_name, subdomain, region, provisioning_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'ready')`,
    [appId, `e2e ${stamp}`, userId, `cust_${appId.replace(/-/g, '_')}`, subdomain, opts.region],
  );

  await mockKv.put(`sub:${subdomain}`, JSON.stringify({ appId, region: opts.region }));

  return { userId, appId, subdomain, region: opts.region, ownerEmail };
}
