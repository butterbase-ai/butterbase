import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import dns from 'node:dns';
import { configureNeonReplication, waitForReplicationCaughtUp, waitForReplicationCaughtUpViaSentinel, promoteSourceToPrimary, dropReplicationObjects } from './neon-replication.js';

const RUN_LIVE = process.env.E2E_LIVE === '1' || process.env.NEON_DATA_PROJECT_ID_US_EAST_1?.includes('localhost');

// macOS host doesn't resolve host.docker.internal by default. Monkey-patch
// dns.lookup so the test harness (running on host) can connect to a URI
// that ALSO resolves from inside Docker containers (the subscriber compute).
const origLookup = dns.lookup;
(dns as any).lookup = (hostname: string, options: any, callback?: any) => {
  // Node's dns.lookup has overloads: (hostname, cb) | (hostname, options, cb).
  let opts = options;
  let cb = callback;
  if (typeof options === 'function') { cb = options; opts = undefined; }
  if (hostname === 'host.docker.internal') {
    if (opts && typeof opts === 'object' && opts.all) {
      return cb(null, [{ address: '127.0.0.1', family: 4 }]);
    }
    return cb(null, '127.0.0.1', 4);
  }
  if (opts === undefined) return (origLookup as any)(hostname, cb);
  return (origLookup as any)(hostname, opts, cb);
};

const TEST_DB = 'cust_repl_test_app';
const TEST_APP_ID = 'repl-test-app';
const TEST_MIG_ID = '00000000-0000-0000-0000-000000000001';

const SRC_ADMIN_URI = 'postgresql://butterbase:butterbase_dev@localhost:5435/postgres';
const DEST_ADMIN_URI = 'postgresql://butterbase:butterbase_dev@localhost:5436/postgres';
// host.docker.internal resolves from inside the source container (Docker
// Desktop on Mac wires it automatically) AND from the host (via the
// dns.lookup shim above).
const DEST_INTERNAL_URI = 'postgresql://butterbase:butterbase_dev@host.docker.internal:5436/' + TEST_DB;

async function ensureTestDb(adminUri: string): Promise<string> {
  const adminPool = new pg.Pool({ connectionString: adminUri });
  try {
    await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid != pg_backend_pid()`, [TEST_DB]).catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await adminPool.query(`CREATE DATABASE ${TEST_DB}`);
  } finally { await adminPool.end(); }
  return adminUri.replace('/postgres', '/' + TEST_DB);
}

describe.skipIf(!RUN_LIVE)('configureNeonReplication (live, two local clusters)', () => {
  let srcCustomerUri: string;
  let destCustomerUri: string;
  let runtimeUsPool: pg.Pool;
  let runtimeEuPool: pg.Pool;

  beforeAll(async () => {
    process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ??= 'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';
    process.env.NEON_RUNTIME_PROJECT_ID_EU_WEST_1 ??= 'postgresql://butterbase:butterbase_dev@localhost:5438/butterbase_runtime_eu';
    process.env.BUTTERBASE_REGIONS ??= 'us-east-1,eu-west-1';

    srcCustomerUri = await ensureTestDb(SRC_ADMIN_URI);
    destCustomerUri = await ensureTestDb(DEST_ADMIN_URI);

    // Seed app_db_connections on each runtime DB
    runtimeUsPool = new pg.Pool({ connectionString: process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 });
    runtimeEuPool = new pg.Pool({ connectionString: process.env.NEON_RUNTIME_PROJECT_ID_EU_WEST_1 });
    // app_db_connections.connection_string must be usable from inside the
    // *other* DB's container (for the subscription's CONNECTION clause), so
    // store the docker-network-internal URI for the dest. The source URI is
    // only ever used by the test harness from the host, so localhost is fine.
    const seedRows: Array<[pg.Pool, string]> = [
      [runtimeUsPool, srcCustomerUri],
      [runtimeEuPool, DEST_INTERNAL_URI],
    ];
    for (const [pool, uri] of seedRows) {
      await pool.query(`DELETE FROM app_db_connections WHERE app_id = $1`, [TEST_APP_ID]);
      await pool.query(`DELETE FROM apps WHERE id = $1`, [TEST_APP_ID]);
      await pool.query(
        `INSERT INTO apps (id, name, owner_id, db_name)
         VALUES ($1, 'repl-test', '00000000-0000-0000-0000-000000000099', $2)`,
        [TEST_APP_ID, TEST_DB],
      );
      await pool.query(
        `INSERT INTO app_db_connections (app_id, neon_project_id, neon_database_name, connection_string)
         VALUES ($1, 'local-test', $2, $3)`,
        [TEST_APP_ID, TEST_DB, uri],
      );
    }

    // Create a tiny shared table on both DBs (publication needs the tables to exist on subscriber too)
    for (const uri of [srcCustomerUri, destCustomerUri]) {
      const p = new pg.Pool({ connectionString: uri });
      try {
        await p.query(`CREATE TABLE IF NOT EXISTS replicated_thing (id INT PRIMARY KEY, val TEXT)`);
      } finally { await p.end(); }
    }
  }, 30_000);

  afterAll(async () => {
    // Drop subscription + publication, drop test DBs, drop app_db_connections.
    const sub = `move_app_sub_${TEST_MIG_ID.replace(/-/g, '')}`.slice(0, 63);
    const pub = `move_app_pub_${TEST_MIG_ID.replace(/-/g, '')}`.slice(0, 63);
    const srcPool = new pg.Pool({ connectionString: srcCustomerUri });
    try { await srcPool.query(`DROP SUBSCRIPTION IF EXISTS "${sub}"`).catch(() => {}); } finally { await srcPool.end(); }
    const destPool = new pg.Pool({ connectionString: destCustomerUri });
    try { await destPool.query(`DROP PUBLICATION IF EXISTS "${pub}"`).catch(() => {}); } finally { await destPool.end(); }

    for (const adminUri of [SRC_ADMIN_URI, DEST_ADMIN_URI]) {
      const adminPool = new pg.Pool({ connectionString: adminUri });
      try {
        await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid != pg_backend_pid()`, [TEST_DB]).catch(() => {});
        await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      } finally { await adminPool.end(); }
    }

    for (const pool of [runtimeUsPool, runtimeEuPool]) {
      await pool.query(`DELETE FROM app_db_connections WHERE app_id = $1`, [TEST_APP_ID]);
      await pool.query(`DELETE FROM apps WHERE id = $1`, [TEST_APP_ID]);
      await pool.end();
    }
  }, 30_000);

  it('creates publication on dest + subscription on source + replicates a row', async () => {
    const r = await configureNeonReplication({
      sourceRegion: 'us-east-1', destRegion: 'eu-west-1', appId: TEST_APP_ID, migrationId: TEST_MIG_ID,
    });
    expect(r.publicationName).toMatch(/^move_app_pub_/);
    expect(r.slotName).toMatch(/^move_app_sub_/);

    // Insert a row on dest, wait briefly, expect to see it on source
    const destPool = new pg.Pool({ connectionString: destCustomerUri });
    try {
      await destPool.query(`INSERT INTO replicated_thing (id, val) VALUES (1, 'hello') ON CONFLICT (id) DO NOTHING`);
    } finally { await destPool.end(); }

    // Poll source for the row (replication is async)
    const srcPool = new pg.Pool({ connectionString: srcCustomerUri });
    try {
      let found = false;
      for (let i = 0; i < 30; i++) {
        const r = await srcPool.query<{ val: string }>(`SELECT val FROM replicated_thing WHERE id = 1`);
        if (r.rows.length === 1 && r.rows[0].val === 'hello') { found = true; break; }
        await new Promise(res => setTimeout(res, 200));
      }
      expect(found).toBe(true);
    } finally { await srcPool.end(); }
  }, 60_000);

  it('is idempotent — second configure call is a no-op and returns same names', async () => {
    const r1 = await configureNeonReplication({
      sourceRegion: 'us-east-1', destRegion: 'eu-west-1', appId: TEST_APP_ID, migrationId: TEST_MIG_ID,
    });
    const r2 = await configureNeonReplication({
      sourceRegion: 'us-east-1', destRegion: 'eu-west-1', appId: TEST_APP_ID, migrationId: TEST_MIG_ID,
    });
    expect(r1).toEqual(r2);
  }, 30_000);

  describe('waitForReplicationCaughtUp', () => {
    it('returns quickly when no pending writes', async () => {
      // Replication is already set up by the prior test. Source should be caught up.
      await expect(
        waitForReplicationCaughtUp({ sourceRegion: 'us-east-1', appId: TEST_APP_ID, migrationId: TEST_MIG_ID, timeoutMs: 10_000 }),
      ).resolves.toBeUndefined();
    }, 15_000);

    it('throws when subscription does not exist', async () => {
      await expect(
        waitForReplicationCaughtUp({ sourceRegion: 'us-east-1', appId: TEST_APP_ID, migrationId: '99999999-9999-9999-9999-999999999999', timeoutMs: 1_000 }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('waitForReplicationCaughtUpViaSentinel', () => {
    it('writes a sentinel on dest and sees it on source', async () => {
      await expect(
        waitForReplicationCaughtUpViaSentinel({
          sourceRegion: 'us-east-1', destRegion: 'eu-west-1', appId: TEST_APP_ID, migrationId: TEST_MIG_ID, timeoutMs: 15_000,
        }),
      ).resolves.toBeUndefined();
    }, 30_000);
  });

  describe.skipIf(!RUN_LIVE)('promoteSourceToPrimary + dropReplicationObjects', () => {
    // Run AFTER the configure/wait tests above. The subscription should still exist.

    it('promoteSourceToPrimary drops the subscription on source', async () => {
      await promoteSourceToPrimary({ sourceRegion: 'us-east-1', appId: TEST_APP_ID, migrationId: TEST_MIG_ID });

      const srcPool = new pg.Pool({ connectionString: srcCustomerUri });
      try {
        const r = await srcPool.query(`SELECT subname FROM pg_subscription WHERE subname LIKE 'move_app_sub_%'`);
        expect(r.rowCount).toBe(0);
      } finally { await srcPool.end(); }
    }, 15_000);

    it('promote is idempotent (second call does not throw)', async () => {
      await expect(
        promoteSourceToPrimary({ sourceRegion: 'us-east-1', appId: TEST_APP_ID, migrationId: TEST_MIG_ID }),
      ).resolves.toBeUndefined();
    }, 10_000);

    it('dropReplicationObjects drops the publication on dest', async () => {
      await dropReplicationObjects({
        sourceRegion: 'us-east-1', destRegion: 'eu-west-1', appId: TEST_APP_ID, migrationId: TEST_MIG_ID,
      });

      const destPool = new pg.Pool({ connectionString: destCustomerUri });
      try {
        const r = await destPool.query(`SELECT pubname FROM pg_publication WHERE pubname LIKE 'move_app_pub_%'`);
        expect(r.rowCount).toBe(0);
      } finally { await destPool.end(); }
    }, 15_000);

    it('drop is idempotent (second call does not throw)', async () => {
      await expect(
        dropReplicationObjects({
          sourceRegion: 'us-east-1', destRegion: 'eu-west-1', appId: TEST_APP_ID, migrationId: TEST_MIG_ID,
        }),
      ).resolves.toBeUndefined();
    }, 10_000);
  });
});
