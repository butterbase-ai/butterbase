import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { executeWithRole } from './rls-context.js';

// Supply only an isolated, disposable PostgreSQL instance. The production
// role migration creates cluster-wide roles, which we remove if we created them.
const adminUrl = process.env.RLS_TEST_PG_URL;
const roles = ['butterbase_anon', 'butterbase_user', 'butterbase_service'] as const;
const userA = 'user-a';
const userB = 'user-b';

describe.skipIf(!adminUrl)('RLS isolation — real Postgres (#172)', () => {
  const database = `bb_rls_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const createdRoles: string[] = [];
  let admin: pg.Pool;
  let pool: pg.Pool;
  let connectionRole: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    const existingRoles = (await admin.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1)', [roles])).rows.map(row => row.rolname);
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    url.searchParams.delete('dbname');
    url.searchParams.delete('database');
    pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
    connectionRole = (await pool.query('SELECT current_user AS name')).rows[0].name;
    for (const file of ['004_rls_helpers.sql', '006_rls_roles.sql']) {
      const sql = await readFile(new URL(`../../../../db/data-plane/${file}`, import.meta.url), 'utf8');
      await pool.query(sql);
    }
    createdRoles.push(...roles.filter(role => !existingRoles.includes(role)));
    await pool.query(`
      CREATE TABLE private_notes (id integer PRIMARY KEY, owner_id text NOT NULL, note text NOT NULL, published boolean DEFAULT false);
      ALTER TABLE private_notes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE private_notes FORCE ROW LEVEL SECURITY;
      CREATE POLICY own_notes ON private_notes FOR ALL TO butterbase_user
        USING (owner_id = current_user_id()) WITH CHECK (owner_id = current_user_id());
      CREATE POLICY published_notes ON private_notes FOR SELECT TO butterbase_anon USING (published);
      CREATE POLICY service_notes ON private_notes FOR ALL TO butterbase_service USING (true) WITH CHECK (true);
      INSERT INTO private_notes VALUES (1, 'user-a', 'private A', false), (2, 'user-b', 'published B', true);
    `);
  });

  beforeEach(async () => { await pool.query('DELETE FROM private_notes WHERE id > 2'); });

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      for (let attempt = 0; ; attempt++) {
        try { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); break; }
        catch (error) {
          if ((error as { code?: string }).code !== '55006' || attempt >= 20) throw error;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      for (const role of createdRoles) await admin.query(`DROP ROLE "${role}"`);
      await admin.end();
    }
  });

  it('demonstrates the documented privileged connection bypass and non-bypass application roles', async () => {
    expect((await pool.query('SELECT id FROM private_notes ORDER BY id')).rows).toEqual([{ id: 1 }, { id: 2 }]);
    const attributes = (await pool.query('SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = ANY($1)', [roles])).rows;
    expect(attributes).toHaveLength(3);
    expect(attributes.every(row => !row.rolbypassrls && !row.rolsuper)).toBe(true);
  });

  it.each([[userA, 1], [userB, 2]])('user %s sees only its own row', async (user, id) => {
    const result = await executeWithRole(pool, 'butterbase_user', String(user), client => client.query('SELECT id FROM private_notes ORDER BY id'));
    expect(result.rows).toEqual([{ id }]);
  });

  it('anonymous access sees only explicitly published rows', async () => {
    const result = await executeWithRole(pool, 'butterbase_anon', null, client => client.query('SELECT id FROM private_notes ORDER BY id'));
    expect(result.rows).toEqual([{ id: 2 }]);
  });

  it('service access is explicitly authorized for all app rows', async () => {
    const result = await executeWithRole(pool, 'butterbase_service', null, client => client.query('SELECT id FROM private_notes ORDER BY id'));
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('blocks cross-user updates, deletes and inserts while allowing an own-row insert', async () => {
    await executeWithRole(pool, 'butterbase_user', userA, async client => {
      expect((await client.query('UPDATE private_notes SET note=$1 WHERE id=2', ['stolen'])).rowCount).toBe(0);
      expect((await client.query('DELETE FROM private_notes WHERE id=2')).rowCount).toBe(0);
    });
    await expect(executeWithRole(pool, 'butterbase_user', userA, client => client.query(
      'INSERT INTO private_notes VALUES (3,$1,$2,false)', [userB, 'forbidden'],
    ))).rejects.toMatchObject({ code: '42501' });
    await executeWithRole(pool, 'butterbase_user', userA, client => client.query('INSERT INTO private_notes VALUES (3,$1,$2,false)', [userA, 'allowed']));
    expect((await pool.query('SELECT note FROM private_notes WHERE id=2')).rows[0].note).toBe('published B');
    expect((await pool.query('SELECT owner_id FROM private_notes WHERE id=3')).rows[0].owner_id).toBe(userA);
  });

  it('does not leak a previous user context when the same pooled connection is reused', async () => {
    const first = await executeWithRole(pool, 'butterbase_user', userA, client => client.query('SELECT pg_backend_pid() AS pid'));
    const second = await executeWithRole(pool, 'butterbase_user', userB, client => client.query('SELECT pg_backend_pid() AS pid, id FROM private_notes'));
    expect(second.rows).toEqual([{ pid: first.rows[0].pid, id: 2 }]);
    const reset = (await pool.query("SELECT current_user AS role, current_setting('request.jwt.claim.sub', true) AS subject, current_setting('app.role', true) AS app_role")).rows[0];
    expect(reset.role).toBe(connectionRole);
    expect([null, '']).toContain(reset.subject);
    expect([null, '']).toContain(reset.app_role);
  });

  it('rolls back customer writes and restores the role when the callback fails', async () => {
    await expect(executeWithRole(pool, 'butterbase_user', userA, async client => {
      await client.query('INSERT INTO private_notes VALUES (3,$1,$2,false)', [userA, 'rolled back']);
      throw new Error('fixture failure');
    })).rejects.toThrow('fixture failure');
    expect((await pool.query('SELECT id FROM private_notes WHERE id=3')).rows).toEqual([]);
    expect((await pool.query('SELECT current_user AS role')).rows[0].role).toBe(connectionRole);
    const next = await executeWithRole(pool, 'butterbase_user', userB, client => client.query('SELECT id FROM private_notes'));
    expect(next.rows).toEqual([{ id: 2 }]);
  });
});
