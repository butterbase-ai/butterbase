import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import { healthRoutes } from '../routes/health.js';
import { initRoutes } from '../routes/init.js';
import { config } from '../config.js';

const app = Fastify();

beforeAll(async () => {
  app.register(databasePlugin);
  app.register(dataPlanePlugin);
  app.register(healthRoutes);
  app.register(initRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('POST /init', () => {
  const appName = `test-${Date.now()}`;
  let appId: string;

  it('provisions a new app and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/init',
      payload: { name: appName },
    });

    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.app_id).toMatch(/^app_[a-z0-9]+$/);
    expect(body.name).toBe(appName);
    expect(body.database.host).toBeDefined();
    expect(body.database.port).toBeDefined();
    expect(body.database.name).toBe(body.app_id);
    expect(body.api_url).toContain(body.app_id);

    appId = body.app_id;
  });

  it('returns the same app on duplicate name (idempotent)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/init',
      payload: { name: appName },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().app_id).toBe(appId);
  });

  it('creates the database on the Data Plane with pgvector', async () => {
    const pool = new pg.Pool({
      host: config.dataPlaneDb.host,
      port: config.dataPlaneDb.port,
      user: config.dataPlaneDb.user,
      password: config.dataPlaneDb.password,
      database: appId,
    });

    try {
      const { rows } = await pool.query(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].extname).toBe('vector');
    } finally {
      await pool.end();
    }
  });

  it('creates _ai_migrations table in the new database', async () => {
    const pool = new pg.Pool({
      host: config.dataPlaneDb.host,
      port: config.dataPlaneDb.port,
      user: config.dataPlaneDb.user,
      password: config.dataPlaneDb.password,
      database: appId,
    });

    try {
      const { rows } = await pool.query(
        "SELECT tablename FROM pg_tables WHERE tablename = '_ai_migrations'"
      );
      expect(rows).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it('records the app in the Control Plane', async () => {
    const { rows } = await app.controlDb.query(
      'SELECT * FROM apps WHERE id = $1',
      [appId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].db_provisioned).toBe(true);
    expect(rows[0].name).toBe(appName);
  });

  it('rejects invalid app names', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/init',
      payload: { name: 'INVALID NAME' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects empty body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/init',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a region not in BUTTERBASE_REGIONS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/init',
      payload: { name: 'demo', region: 'mars-1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not in BUTTERBASE_REGIONS/);
  });
});
