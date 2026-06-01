/**
 * Round-trip tests for the `_seed: true` schema-DSL marker.
 *
 * The marker is stored in the per-app `_seed_tables` table (data-plane
 * migration 012) and read back by the introspector.  Clone-time row copy
 * is deferred to Phase 5.
 *
 * This test creates a temporary database on the data-plane, bootstraps
 * the minimal required tables (_ai_migrations, _seed_tables), and calls
 * applyMigration + introspectSchema directly — bypassing the HTTP routes so
 * no app provisioning or runtime-DB setup is needed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { config } from '../config.js';
import { applyMigration } from '../services/schema-applier.js';
import { introspectSchema } from '../services/schema-introspector.js';
import { diffSchema } from '../services/schema-differ.js';

// Connect to the data-plane postgres as superuser to create/drop a test DB
const adminPool = new pg.Pool({
  host: config.dataPlaneDb.host,
  port: config.dataPlaneDb.port,
  user: config.dataPlaneDb.user,
  password: config.dataPlaneDb.password,
  database: 'postgres', // connect to postgres to create/drop DBs
  max: 2,
});

const testDbName = `test_seed_${Date.now()}`;
let testPool: pg.Pool;

beforeAll(async () => {
  // Create an isolated test database
  await adminPool.query(`CREATE DATABASE "${testDbName}"`);

  testPool = new pg.Pool({
    host: config.dataPlaneDb.host,
    port: config.dataPlaneDb.port,
    user: config.dataPlaneDb.user,
    password: config.dataPlaneDb.password,
    database: testDbName,
    max: 5,
  });

  // Bootstrap the minimal data-plane tables that applyMigration depends on
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS _ai_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      applied_by TEXT NOT NULL DEFAULT 'system',
      sql_up TEXT NOT NULL,
      sql_down TEXT,
      checksum TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await testPool.query(`
    CREATE TABLE IF NOT EXISTS _seed_tables (
      name TEXT PRIMARY KEY
    )
  `);

  // Create the RLS roles that GRANT statements require (no-op if they exist)
  for (const role of ['butterbase_anon', 'butterbase_user', 'butterbase_service']) {
    await testPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE ${role};
      END IF;
    END $$`);
  }
}, 30000);

afterAll(async () => {
  await testPool.end();
  // Drop the test database using the admin pool
  await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
  await adminPool.end();
});

describe('_seed: true round-trip through applier + introspector', () => {
  const baseColumns = {
    code: { type: 'text', primaryKey: true },
    country_name: { type: 'text', nullable: false },
  };

  it('applies a schema with _seed: true and introspects it back', async () => {
    const desired = {
      tables: {
        countries: {
          columns: baseColumns,
          _seed: true as const,
        },
      },
    };

    const current = await introspectSchema(testPool);
    const statements = diffSchema(current, desired);
    expect(statements.length).toBeGreaterThan(0);

    await applyMigration(testPool, statements, 'create_countries_with_seed');

    // Sync _seed_tables: countries has _seed: true → insert
    await testPool.query(
      `INSERT INTO _seed_tables (name) VALUES ($1) ON CONFLICT DO NOTHING`,
      ['countries']
    );

    const introspected = await introspectSchema(testPool);
    expect(introspected.tables.countries).toBeDefined();
    expect(introspected.tables.countries._seed).toBe(true);
  });

  it('removes _seed when flag is cleared from _seed_tables', async () => {
    // Remove countries from _seed_tables (simulating _seed: false/omitted apply)
    await testPool.query(`DELETE FROM _seed_tables WHERE name = 'countries'`);

    const introspected = await introspectSchema(testPool);
    expect(introspected.tables.countries).toBeDefined();
    // _seed must be absent (introspector only sets it to true, never writes false)
    expect(introspected.tables.countries._seed).toBeFalsy();
  });

  it('re-enables _seed after it was cleared', async () => {
    await testPool.query(
      `INSERT INTO _seed_tables (name) VALUES ($1) ON CONFLICT DO NOTHING`,
      ['countries']
    );

    const introspected = await introspectSchema(testPool);
    expect(introspected.tables.countries._seed).toBe(true);
  });

  it('only marks seeded tables — non-seeded tables in the same schema are unaffected', async () => {
    // Add a second table (no seed)
    const withCities = {
      tables: {
        countries: { columns: baseColumns, _seed: true as const },
        cities: {
          columns: {
            id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
            city_name: { type: 'text', nullable: false },
          },
        },
      },
    };

    const current = await introspectSchema(testPool);
    const statements = diffSchema(current, withCities);
    // Only cities is new — countries already exists
    await applyMigration(testPool, statements, 'add_cities');

    // cities has no _seed entry — countries already has one
    const introspected = await introspectSchema(testPool);
    expect(introspected.tables.countries._seed).toBe(true);
    expect(introspected.tables.cities._seed).toBeFalsy();
  });
});
