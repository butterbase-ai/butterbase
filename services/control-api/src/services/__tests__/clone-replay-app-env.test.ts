import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../crypto.js';
import { replayAppEnvVars } from '../clone-app-env.js';
import { runtimeDb } from '../../__tests__/test-helpers/control-db.js';
import { randomUUID } from 'node:crypto';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

// clone-flow-integration sibling of clone-app-env.test.ts. clone-app-env.test.ts
// covers unit-level contract (copy/no-op/overwrite); this proves the module
// composes with the rest of the clone flow (real pg pool, real crypto envelope).
describeDb('replayAppEnvVars in clone integration context', () => {
  const encKey = process.env.AUTH_ENCRYPTION_KEY!;
  it('is invocable as part of the clone flow and produces a decryptable dest blob', async () => {
    const userId = randomUUID();
    const src = `app_clone_wire_src_${userId.slice(0, 8)}`;
    const dst = `app_clone_wire_dst_${userId.slice(0, 8)}`;
    await runtimeDb.query(`DELETE FROM app_env_vars WHERE app_id IN ($1, $2)`, [src, dst]);
    for (const id of [src, dst]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1') ON CONFLICT DO NOTHING`,
        [id, userId],
      );
    }
    await runtimeDb.query(
      `INSERT INTO app_env_vars (app_id, encrypted_env_vars, updated_by) VALUES ($1, $2, $3)`,
      [src, encrypt(JSON.stringify({ SHARED_TOKEN: 'from_source' }), encKey), userId],
    );

    const res = await replayAppEnvVars(runtimeDb, runtimeDb, src, dst, userId);
    expect(res.copied).toBe(true);

    const row = await runtimeDb.query<{ encrypted_env_vars: string }>(
      `SELECT encrypted_env_vars FROM app_env_vars WHERE app_id = $1`, [dst],
    );
    const decoded = JSON.parse(decrypt(row.rows[0].encrypted_env_vars, encKey));
    expect(decoded).toEqual({ SHARED_TOKEN: 'from_source' });
  });
});
