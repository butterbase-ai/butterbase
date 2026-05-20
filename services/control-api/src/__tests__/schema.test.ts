import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import { initRoutes } from '../routes/init.js';
import { schemaRoutes } from '../routes/schema.js';
import { config } from '../config.js';

const app = Fastify();
let appId: string;

beforeAll(async () => {
  // Inject a test auth context so requireUserId() succeeds without a real JWT
  app.decorateRequest('auth', null as any);
  app.addHook('onRequest', async (request) => {
    (request as any).auth = {
      userId: config.devOwnerId,
      authMethod: 'api_key',
      scopes: ['*'],
    };
  });

  app.register(databasePlugin);
  app.register(dataPlanePlugin);
  app.register(initRoutes);
  app.register(schemaRoutes);
  await app.ready();

  // Provision a test app
  const res = await app.inject({
    method: 'POST',
    url: '/init',
    payload: { name: `schema-test-${Date.now()}` },
  });
  appId = res.json().app_id;

  // Wait for background provisioning to complete (local dev uses setImmediate)
  for (let i = 0; i < 30; i++) {
    const status = await app.inject({ method: 'GET', url: `/apps/${appId}/status` });
    const { provisioning_status } = status.json();
    if (provisioning_status === 'ready') break;
    if (provisioning_status === 'failed') throw new Error('Test app provisioning failed');
    await new Promise((r) => setTimeout(r, 200));
  }
});

afterAll(async () => {
  await app.close();
});

describe('GET /v1/:app_id/schema', () => {
  it('returns empty schema for new app', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/${appId}/schema` });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.app_id).toBe(appId);
    expect(body.schema.tables).toEqual({});
  });

  it('returns 404 for non-existent app', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/app_doesnotexist/schema' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/:app_id/schema/apply', () => {
  const todoSchema = {
    tables: {
      todos: {
        columns: {
          id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
          title: { type: 'text', nullable: false },
          done: { type: 'boolean', default: 'false' },
          created_at: { type: 'timestamptz', default: 'now()' },
        },
      },
    },
  };

  it('creates a table from schema', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/schema/apply`,
      payload: { schema: todoSchema, name: 'create_todos' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.applied).toBeGreaterThan(0);
    expect(body.migration_id).toBeDefined();
  });

  it('reflects the new table in GET /schema', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/${appId}/schema` });
    const body = res.json();

    expect(body.schema.tables.todos).toBeDefined();
    expect(body.schema.tables.todos.columns.id).toBeDefined();
    expect(body.schema.tables.todos.columns.title).toBeDefined();
    expect(body.schema.tables.todos.columns.done).toBeDefined();
  });

  it('returns "up to date" when schema unchanged', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/schema/apply`,
      payload: { schema: todoSchema },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(0);
    expect(res.json().message).toContain('up to date');
  });

  it('adds a new column when schema changes', async () => {
    const updated = JSON.parse(JSON.stringify(todoSchema));
    updated.tables.todos.columns.priority = { type: 'integer', default: '0' };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/schema/apply`,
      payload: { schema: updated, name: 'add_priority' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBeGreaterThan(0);
  });

  it('supports dry_run mode', async () => {
    const newSchema = JSON.parse(JSON.stringify(todoSchema));
    newSchema.tables.todos.columns.notes = { type: 'text' };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/schema/apply`,
      payload: { schema: newSchema, dry_run: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dry_run).toBe(true);
    expect(body.statements.length).toBeGreaterThan(0);
    expect(body.statements[0].sql).toContain('ADD COLUMN');
  });

  it('rejects invalid column types', async () => {
    const bad = {
      tables: {
        evil: {
          columns: {
            id: { type: "text; DROP TABLE todos; --" },
          },
        },
      },
    };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/schema/apply`,
      payload: { schema: bad },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_INVALID_SCHEMA');
  });

  it('blocks unauthorized destructive operations', async () => {
    // Apply a schema that removes the todos table (without _drop)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/schema/apply`,
      payload: { schema: { tables: {} } },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SCHEMA_DESTRUCTIVE_CHANGE');
  });

  it('returns 404 for non-existent app', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/app_doesnotexist/schema/apply',
      payload: { schema: todoSchema },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Foreign key referential actions', () => {
  const baseSchema = {
    tables: {
      // Include todos so diffSchema doesn't flag it as a destructive drop
      todos: {
        columns: {
          id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
          title: { type: 'text', nullable: false },
          done: { type: 'boolean', default: 'false' },
          created_at: { type: 'timestamptz', default: 'now()' },
          priority: { type: 'integer', default: '0' },
        },
      },
      users: {
        columns: {
          id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
          name: { type: 'text' },
        },
      },
      posts: {
        columns: {
          id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
          user_id: { type: 'uuid', references: 'users.id' },
          title: { type: 'text' },
        },
      },
    },
  };

  it('creates FK with string references (NO ACTION default)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/schema/apply`,
      payload: { schema: baseSchema, name: 'create_fk_tables' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBeGreaterThan(0);

    // Verify introspection returns string form (NO ACTION)
    const get = await app.inject({ method: 'GET', url: `/v1/${appId}/schema` });
    expect(get.json().schema.tables.posts.columns.user_id.references).toBe('users.id');
  });

  it('changes FK behavior from NO ACTION to CASCADE', async () => {
    const cascadeSchema = JSON.parse(JSON.stringify(baseSchema));
    cascadeSchema.tables.posts.columns.user_id = {
      type: 'uuid',
      references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
    };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/schema/apply`,
      payload: { schema: cascadeSchema, name: 'add_cascade' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBeGreaterThan(0);

    // Verify the SQL includes DROP + ADD CONSTRAINT
    const stmts = res.json().statements;
    expect(stmts.some((s: any) => s.sql.includes('DROP CONSTRAINT'))).toBe(true);
    expect(stmts.some((s: any) => s.sql.includes('ON DELETE CASCADE'))).toBe(true);
  });

  it('introspects CASCADE FK as object form', async () => {
    const get = await app.inject({ method: 'GET', url: `/v1/${appId}/schema` });
    const ref = get.json().schema.tables.posts.columns.user_id.references;
    expect(ref).toEqual({ table: 'users', column: 'id', onDelete: 'CASCADE' });
  });

  it('is idempotent when CASCADE already applied', async () => {
    const cascadeSchema = JSON.parse(JSON.stringify(baseSchema));
    cascadeSchema.tables.posts.columns.user_id = {
      type: 'uuid',
      references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
    };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/schema/apply`,
      payload: { schema: cascadeSchema },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(0);
    expect(res.json().message).toContain('up to date');
  });

  it('supports SET NULL on delete', async () => {
    const setNullSchema = JSON.parse(JSON.stringify(baseSchema));
    setNullSchema.tables.posts.columns.user_id = {
      type: 'uuid',
      references: { table: 'users', column: 'id', onDelete: 'SET NULL' },
    };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/schema/apply`,
      payload: { schema: setNullSchema, name: 'set_null_fk' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBeGreaterThan(0);

    const get = await app.inject({ method: 'GET', url: `/v1/${appId}/schema` });
    const ref = get.json().schema.tables.posts.columns.user_id.references;
    expect(ref).toEqual({ table: 'users', column: 'id', onDelete: 'SET NULL' });
  });

  it('rejects invalid referential action', async () => {
    const bad = JSON.parse(JSON.stringify(baseSchema));
    bad.tables.posts.columns.user_id = {
      type: 'uuid',
      references: { table: 'users', column: 'id', onDelete: 'DESTROY' },
    };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/schema/apply`,
      payload: { schema: bad },
    });
    expect(res.statusCode).toBe(400);
  });

  it('dry-run shows FK behavior change statements', async () => {
    const drySchema = JSON.parse(JSON.stringify(baseSchema));
    drySchema.tables.posts.columns.user_id = {
      type: 'uuid',
      references: { table: 'users', column: 'id', onDelete: 'RESTRICT' },
    };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/schema/apply`,
      payload: { schema: drySchema, dry_run: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dry_run).toBe(true);
    expect(res.json().statements.some((s: any) => s.sql.includes('DROP CONSTRAINT'))).toBe(true);
  });

  it('supports onUpdate referential action', async () => {
    const updateSchema = JSON.parse(JSON.stringify(baseSchema));
    updateSchema.tables.posts.columns.user_id = {
      type: 'uuid',
      references: { table: 'users', column: 'id', onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/schema/apply`,
      payload: { schema: updateSchema, name: 'add_on_update' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBeGreaterThan(0);

    const get = await app.inject({ method: 'GET', url: `/v1/${appId}/schema` });
    const ref = get.json().schema.tables.posts.columns.user_id.references;
    expect(ref).toEqual({ table: 'users', column: 'id', onDelete: 'CASCADE', onUpdate: 'CASCADE' });
  });

  it('does not expose _fkConstraints in GET response', async () => {
    const get = await app.inject({ method: 'GET', url: `/v1/${appId}/schema` });
    expect(get.json().schema._fkConstraints).toBeUndefined();
  });
});
