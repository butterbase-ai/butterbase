import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import { initRoutes } from '../routes/init.js';
import { schemaRoutes } from '../routes/schema.js';
import { autoApiRoutes } from '../routes/auto-api.js';

const app = Fastify();
let appId: string;
let insertedId: string;

beforeAll(async () => {
  app.register(databasePlugin);
  app.register(dataPlanePlugin);
  app.register(initRoutes);
  app.register(schemaRoutes);
  app.register(autoApiRoutes);
  await app.ready();

  // Provision app and create table
  const initRes = await app.inject({
    method: 'POST',
    url: '/init',
    payload: { name: `autoapi-test-${Date.now()}` },
  });
  appId = initRes.json().app_id;

  await app.inject({
    method: 'POST',
    url: `/v1/${appId}/schema/apply`,
    payload: {
      schema: {
        tables: {
          posts: {
            columns: {
              id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
              title: { type: 'text', nullable: false },
              body: { type: 'text' },
              published: { type: 'boolean', default: 'false' },
              created_at: { type: 'timestamptz', default: 'now()' },
            },
          },
        },
      },
    },
  });
});

afterAll(async () => {
  await app.close();
});

describe('Auto-API CRUD', () => {
  it('POST /v1/:app_id/:table inserts a row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/posts`,
      payload: { title: 'Hello World', body: 'First post' },
    });

    expect(res.statusCode).toBe(201);
    const row = res.json();
    expect(row.id).toBeDefined();
    expect(row.title).toBe('Hello World');
    expect(row.body).toBe('First post');
    expect(row.published).toBe(false);
    insertedId = row.id;
  });

  it('GET /v1/:app_id/:table lists rows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/posts`,
    });

    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].title).toBe('Hello World');
  });

  it('GET /v1/:app_id/:table/:id gets by ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/posts/${insertedId}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(insertedId);
    expect(res.json().title).toBe('Hello World');
  });

  it('PATCH /v1/:app_id/:table/:id updates a row', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/${appId}/posts/${insertedId}`,
      payload: { title: 'Updated Title', published: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Updated Title');
    expect(res.json().published).toBe(true);
  });

  it('GET with filter ?title=eq.Updated%20Title works', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/posts?title=eq.Updated Title`,
    });

    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe('Updated Title');
  });

  it('GET with select param returns only chosen columns', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/posts?select=id,title`,
    });

    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows[0]).toHaveProperty('id');
    expect(rows[0]).toHaveProperty('title');
    expect(rows[0]).not.toHaveProperty('body');
  });

  it('GET with limit and order works', async () => {
    // Insert a second row
    await app.inject({
      method: 'POST',
      url: `/v1/${appId}/posts`,
      payload: { title: 'Second Post', body: 'Another one' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/posts?order=title.asc&limit=1`,
    });

    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.length).toBe(1);
  });

  it('DELETE /v1/:app_id/:table/:id deletes a row', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/${appId}/posts/${insertedId}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);

    // Verify it's gone
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/posts/${insertedId}`,
    });
    expect(getRes.statusCode).toBe(404);
  });
});

describe('Auto-API validation', () => {
  it('returns 404 for non-existent table', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/nonexistent`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('not found');
  });

  it('returns 404 for non-existent app', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/app_doesnotexist/posts',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for POST with no valid columns', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/posts`,
      payload: { invalid_column: 'test' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for DELETE non-existent ID', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/${appId}/posts/00000000-0000-0000-0000-000000000000`,
    });
    expect(res.statusCode).toBe(404);
  });
});
