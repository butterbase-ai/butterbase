import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { introspectSchema } from '../services/schema-introspector.js';
import { diffSchema } from '../services/schema-differ.js';
import { filterAdditive } from '../services/schema-additive-filter.js';
import { applyMigration } from '../services/schema-applier.js';

// NOTE on DATA_DB_URL: the data-plane container on port 5435 has no
// `butterbase_data` database — its only non-template databases are
// `postgres`, `app_tmpl_crm` and `app_fork_crm` (the latter two are
// fixtures from a prior cycle, left alone deliberately; do not write to
// them). Default here points at the always-present `postgres` maintenance
// database, used only to open an admin connection for provisioning two
// throwaway databases below.
const ADMIN_URL = process.env.DATA_DB_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5435/postgres';

// introspectSchema reads `pg_tables WHERE schemaname = 'public'` — i.e. it
// scopes to one database, not a namespace within a shared one. A "source"
// and a "fork" pool that both point at the same database (as a first draft
// of this test did, and as the brief's snippet does verbatim) see the exact
// same table list, so diffSchema always returns an empty diff and the guard
// assertion below can never hold — not a filterAdditive defect, a wiring
// defect. Real per-app isolation is one Postgres database per app, so this
// test provisions two real, uniquely-named throwaway databases — one
// standing in for the template, one for the fork — and drops them (not
// just their tables) in afterAll.
function withDb(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const TMPL_DB = 'zz_test_template_update_tmpl';
const FORK_DB = 'zz_test_template_update_fork';

describe('in-place update preserves fork data', () => {
  let admin: pg.Pool;
  let source: pg.Pool;
  let fork: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL });

    // Recreate both throwaway databases from scratch.
    await admin.query(`DROP DATABASE IF EXISTS ${TMPL_DB} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${FORK_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TMPL_DB}`);
    await admin.query(`CREATE DATABASE ${FORK_DB}`);

    source = new pg.Pool({ connectionString: withDb(ADMIN_URL, TMPL_DB) });
    fork = new pg.Pool({ connectionString: withDb(ADMIN_URL, FORK_DB) });

    // Template gains a column the fork does not have.
    await source.query(`CREATE TABLE tmpl_posts (id text primary key, title text, subtitle text)`);

    // applyMigration logs to `_ai_migrations`, which real per-app databases
    // get from data-plane bootstrap migration 003 at provisioning time.
    // These throwaway databases skip that pipeline, so create it directly
    // (same DDL as db/data-plane/003_migration_tracking.sql).
    await fork.query(`
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

    // Fork: a DIFFERENT table name from the template's tmpl_posts (fork_posts,
    // not tmpl_posts), plus its own table, column, index and rows. Because
    // the names differ, diffSchema's per-table ALTER path is never reached
    // for these — only the whole-table "current has it, desired doesn't"
    // DROP TABLE path (schema-differ.ts step 4) fires, and everything here
    // survives *because the whole table is spared*, not because a column-
    // or index-level statement was filtered. The 'shared table name' test
    // below exercises the ALTER path (DROP COLUMN / DROP INDEX) instead.
    await fork.query(`CREATE TABLE fork_posts (id text primary key, title text, fork_col text)`);
    await fork.query(`CREATE TABLE fork_only (id text primary key, payload text)`);
    await fork.query(`CREATE INDEX idx_fork_only_payload ON fork_only (payload)`);
    await fork.query(`INSERT INTO fork_only VALUES ('r1','precious'), ('r2','also precious')`);
    await fork.query(`INSERT INTO fork_posts VALUES ('p1','hello','mine')`);
  });

  afterAll(async () => {
    await source.end();
    await fork.end();
    await admin.query(`DROP DATABASE IF EXISTS ${TMPL_DB} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${FORK_DB} WITH (FORCE)`);
    await admin.end();
  });

  it('never drops a fork-only table, column, index or row', async () => {
    const desired = await introspectSchema(source);
    const current = await introspectSchema(fork);
    const raw = diffSchema(current as never, desired as never);

    // The unfiltered diff MUST want to drop fork-only objects — if this
    // assertion ever fails, the hazard moved and this test is no longer
    // guarding it.
    expect(raw.some((s) => /DROP TABLE/i.test(s.sql))).toBe(true);

    const { kept, rejected } = filterAdditive(raw);
    expect(rejected.length).toBeGreaterThan(0);
    expect(kept.every((s) => !/DROP|TRUNCATE/i.test(s.sql))).toBe(true);

    await applyMigration(fork, kept, 'test-update');

    const tables = await fork.query(
      `SELECT tablename FROM pg_tables WHERE tablename IN ('fork_only','fork_posts')`);
    expect(tables.rows).toHaveLength(2);

    const col = await fork.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='fork_posts' AND column_name='fork_col'`);
    expect(col.rows).toHaveLength(1);

    const idx = await fork.query(
      `SELECT 1 FROM pg_indexes WHERE indexname='idx_fork_only_payload'`);
    expect(idx.rows).toHaveLength(1);

    const rows = await fork.query(`SELECT count(*)::int AS n FROM fork_only`);
    expect(rows.rows[0].n).toBe(2);
  });

  it('never drops a fork-only column or index on a table the fork shares by name with the template', async () => {
    // Both databases have a table named `posts` — this is what exercises
    // diffSchema's per-table ALTER path (DROP COLUMN / DROP INDEX), which
    // the whole-table scenario above never reaches.
    await source.query(`DROP TABLE IF EXISTS posts CASCADE`);
    await source.query(`CREATE TABLE posts (id text primary key, title text, tmpl_col text)`);

    await fork.query(`DROP TABLE IF EXISTS posts CASCADE`);
    await fork.query(`CREATE TABLE posts (id text primary key, title text, fork_col text)`);
    await fork.query(`CREATE INDEX idx_posts_fork_col ON posts (fork_col)`);
    await fork.query(`INSERT INTO posts VALUES ('p1','hello','mine'), ('p2','world','also mine')`);

    const desired = await introspectSchema(source);
    const current = await introspectSchema(fork);
    const raw = diffSchema(current as never, desired as never);

    // Guard the guard: the unfiltered diff must genuinely want to remove the
    // fork's column and/or index on this shared-name table via the ALTER
    // path (schema-differ.ts's per-table alter loop), not the whole-table
    // DROP TABLE path the first scenario exercises. `DROP INDEX IF EXISTS
    // "idx_posts_fork_col"` does not repeat the table name in its SQL text
    // (unlike DROP TABLE), so this checks the whole raw diff rather than
    // filtering by table name first — a name-based filter here previously
    // missed the very statement it was meant to catch. If this assertion
    // ever fails, say so — don't loosen it to pass.
    expect(
      raw.some((s) => /DROP\s+COLUMN/i.test(s.sql) || /DROP\s+INDEX/i.test(s.sql))
    ).toBe(true);

    const { kept, rejected } = filterAdditive(raw);
    expect(rejected.length).toBeGreaterThan(0);
    expect(kept.every((s) => !/DROP|TRUNCATE/i.test(s.sql))).toBe(true);

    await applyMigration(fork, kept, 'test-update-shared-name');

    // Fork's own column survives.
    const forkCol = await fork.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='posts' AND column_name='fork_col'`);
    expect(forkCol.rows).toHaveLength(1);

    // Fork's own index survives.
    const forkIdx = await fork.query(
      `SELECT 1 FROM pg_indexes WHERE indexname='idx_posts_fork_col'`);
    expect(forkIdx.rows).toHaveLength(1);

    // Fork's rows survive.
    const rows = await fork.query(`SELECT count(*)::int AS n FROM posts`);
    expect(rows.rows[0].n).toBe(2);

    // The template's new column landed.
    const tmplCol = await fork.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='posts' AND column_name='tmpl_col'`);
    expect(tmplCol.rows).toHaveLength(1);
  });
});
