import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import sourceReplicaRoutes from './source-replicas.js';

const PLATFORM_URL =
  process.env.NEON_PLATFORM_PRIMARY_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let app: ReturnType<typeof Fastify>;
let pool: pg.Pool;
let userId: string;
let migrationId: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: PLATFORM_URL });

  const r = await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES (gen_random_uuid(), 'source-replica-test@example.com', 'active', 'launch')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
  );
  userId = r.rows[0].id;

  // Insert a completed migration with source_replica_state = 'replicating'
  const m = await pool.query(
    `INSERT INTO app_migrations
       (id, user_id, app_id, source_region, dest_region, current_step, source_replica_state, dest_resources, completed_at)
     VALUES
       (gen_random_uuid(), $1, 'app-replica-test', 'us-east-1', 'eu-west-1',
        'completed', 'replicating', '{"dump_bytes": 1073741824}'::jsonb, now())
     RETURNING id`,
    [userId],
  );
  migrationId = m.rows[0].id;

  app = Fastify();
  app.decorate('controlDb', pool);
  app.decorate('moveAppCtx', { enqueueDeprovision: async () => {} });
  // Inject auth so requireUserId finds a userId
  app.addHook('preHandler', async (request: any) => {
    request.auth = { userId };
  });
  await app.register(sourceReplicaRoutes);
  await app.ready();
});

afterAll(async () => {
  await pool.query(`DELETE FROM app_migrations WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM platform_users WHERE id = $1`, [userId]);
  await app.close();
  await pool.end();
});

describe('GET /v1/source-replicas', () => {
  it('returns list of active source replicas', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/source-replicas' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toHaveProperty('source_replicas');
    expect(Array.isArray(body.source_replicas)).toBe(true);
    const found = body.source_replicas.find((row: any) => row.migration_id === migrationId);
    expect(found).toBeDefined();
    expect(found.app_id).toBe('app-replica-test');
  });
});

describe('DELETE /v1/source-replicas/:migration_id', () => {
  it('returns 404 for unknown migration_id', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: '/v1/source-replicas/00000000-0000-0000-0000-000000000000',
    });
    expect(r.statusCode).toBe(404);
  });

  it('tears down an active source replica', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: `/v1/source-replicas/${migrationId}`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('torn_down');
  });

  it('returns 409 when replica is already torn down', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: `/v1/source-replicas/${migrationId}`,
    });
    expect(r.statusCode).toBe(409);
  });
});
