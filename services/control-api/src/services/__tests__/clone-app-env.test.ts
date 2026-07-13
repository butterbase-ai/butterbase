import { describe, it, expect, beforeEach } from 'vitest';
import { encrypt, decrypt } from '../crypto.js';
import { replayAppEnvVars } from '../clone-app-env.js';
import { runtimeDb } from '../../__tests__/test-helpers/control-db.js';
import { randomUUID } from 'node:crypto';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

describeDb('replayAppEnvVars', () => {
  const encKey = process.env.AUTH_ENCRYPTION_KEY!;
  let sourceAppId: string;
  let destAppId: string;
  let userId: string;

  beforeEach(async () => {
    userId = randomUUID();
    sourceAppId = `app_env_replay_src_${userId.slice(0, 8)}`;
    destAppId   = `app_env_replay_dst_${userId.slice(0, 8)}`;
    await runtimeDb.query(
      `DELETE FROM app_env_vars WHERE app_id IN ($1, $2)`,
      [sourceAppId, destAppId],
    );
    for (const id of [sourceAppId, destAppId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region)
         VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, userId],
      );
    }
  });

  it('copies and re-encrypts source app_env_vars to dest', async () => {
    await runtimeDb.query(
      `INSERT INTO app_env_vars (app_id, encrypted_env_vars, updated_by) VALUES ($1, $2, $3)`,
      [sourceAppId, encrypt(JSON.stringify({ STRIPE_SECRET: 'sk_x', SHARED_TOKEN: 'tkn' }), encKey), userId],
    );
    const res = await replayAppEnvVars(runtimeDb, runtimeDb, sourceAppId, destAppId, userId);
    expect(res).toEqual({ copied: true, keyCount: 2 });
    const row = await runtimeDb.query<{ encrypted_env_vars: string; updated_by: string }>(
      `SELECT encrypted_env_vars, updated_by FROM app_env_vars WHERE app_id = $1`,
      [destAppId],
    );
    expect(row.rows[0].updated_by).toBe(userId);
    const decoded = JSON.parse(decrypt(row.rows[0].encrypted_env_vars, encKey));
    expect(decoded).toEqual({ STRIPE_SECRET: 'sk_x', SHARED_TOKEN: 'tkn' });
  });

  it('no-ops when source has no row', async () => {
    const res = await replayAppEnvVars(runtimeDb, runtimeDb, sourceAppId, destAppId, userId);
    expect(res).toEqual({ copied: false, keyCount: 0 });
    const row = await runtimeDb.query(`SELECT 1 FROM app_env_vars WHERE app_id = $1`, [destAppId]);
    expect(row.rows.length).toBe(0);
  });

  it('overwrites an existing dest row (partial re-run scenario)', async () => {
    await runtimeDb.query(
      `INSERT INTO app_env_vars (app_id, encrypted_env_vars, updated_by) VALUES ($1, $2, $3)`,
      [sourceAppId, encrypt(JSON.stringify({ K: 'from_source' }), encKey), userId],
    );
    const otherUser = randomUUID();
    await runtimeDb.query(
      `INSERT INTO app_env_vars (app_id, encrypted_env_vars, updated_by) VALUES ($1, $2, $3)`,
      [destAppId, encrypt(JSON.stringify({ K: 'from_prior_run' }), encKey), otherUser],
    );
    await replayAppEnvVars(runtimeDb, runtimeDb, sourceAppId, destAppId, userId);
    const row = await runtimeDb.query<{ encrypted_env_vars: string }>(
      `SELECT encrypted_env_vars FROM app_env_vars WHERE app_id = $1`,
      [destAppId],
    );
    const decoded = JSON.parse(decrypt(row.rows[0].encrypted_env_vars, encKey));
    expect(decoded).toEqual({ K: 'from_source' });
  });
});
