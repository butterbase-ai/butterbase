import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { replaySubstrateLink } from '../clone-replay.js';
import { runtimeDb, controlDb } from '../../__tests__/test-helpers/control-db.js';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;
const noopLogger = { info() {}, warn() {} };

describeDb('replaySubstrateLink', () => {
  async function seedApps(ownerId: string, slug: string, sourceSubstrateUserId: string | null) {
    const srcId = `app_subs_src_${slug}`;
    const destId = `app_subs_dst_${slug}`;
    await controlDb.query(
      `INSERT INTO platform_users (id, email, email_verified) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING`,
      [ownerId, `subs-${ownerId}@x.com`],
    );
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerId],
      );
    }
    await runtimeDb.query(
      `UPDATE apps SET substrate_user_id = $1 WHERE id = $2`,
      [sourceSubstrateUserId, srcId],
    );
    await runtimeDb.query(
      `UPDATE apps SET substrate_user_id = NULL WHERE id = $1`,
      [destId],
    );
    return { srcId, destId };
  }

  async function cleanup(srcId: string, destId: string, ownerId: string) {
    await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
  }

  it('links the dest to the cloner when source had any substrate link', async () => {
    const ownerId = randomUUID();
    const clonerId = randomUUID();
    const sourceSubstrateUserId = randomUUID();
    const slug = ownerId.slice(0, 8);
    const { srcId, destId } = await seedApps(ownerId, slug, sourceSubstrateUserId);

    const result = await replaySubstrateLink(runtimeDb, runtimeDb, srcId, destId, clonerId, noopLogger);
    expect(result.warnings).toEqual([]);

    const row = await runtimeDb.query<{ substrate_user_id: string | null }>(
      `SELECT substrate_user_id FROM apps WHERE id = $1`,
      [destId],
    );
    expect(row.rows[0].substrate_user_id, 'dest must link to cloner, not source owner').toBe(clonerId);
    expect(row.rows[0].substrate_user_id).not.toBe(sourceSubstrateUserId);

    await cleanup(srcId, destId, ownerId);
  });

  it('is a no-op when source was never linked', async () => {
    const ownerId = randomUUID();
    const clonerId = randomUUID();
    const slug = ownerId.slice(0, 8);
    const { srcId, destId } = await seedApps(ownerId, slug, null);

    const result = await replaySubstrateLink(runtimeDb, runtimeDb, srcId, destId, clonerId, noopLogger);
    expect(result.warnings).toEqual([]);

    const row = await runtimeDb.query<{ substrate_user_id: string | null }>(
      `SELECT substrate_user_id FROM apps WHERE id = $1`,
      [destId],
    );
    expect(row.rows[0].substrate_user_id, 'dest must stay NULL when source had no link').toBeNull();

    await cleanup(srcId, destId, ownerId);
  });

  it('is idempotent: re-running does not overwrite if dest already linked to cloner', async () => {
    const ownerId = randomUUID();
    const clonerId = randomUUID();
    const sourceSubstrateUserId = randomUUID();
    const slug = ownerId.slice(0, 8);
    const { srcId, destId } = await seedApps(ownerId, slug, sourceSubstrateUserId);

    await replaySubstrateLink(runtimeDb, runtimeDb, srcId, destId, clonerId, noopLogger);
    const firstUpdated = await runtimeDb.query<{ updated_at: Date }>(
      `SELECT updated_at FROM apps WHERE id = $1`,
      [destId],
    );

    // Sleep a tick so a second UPDATE would visibly bump updated_at if it ran.
    await new Promise((r) => setTimeout(r, 50));

    const second = await replaySubstrateLink(runtimeDb, runtimeDb, srcId, destId, clonerId, noopLogger);
    expect(second.warnings).toEqual([]);

    const after = await runtimeDb.query<{ substrate_user_id: string | null; updated_at: Date }>(
      `SELECT substrate_user_id, updated_at FROM apps WHERE id = $1`,
      [destId],
    );
    expect(after.rows[0].substrate_user_id).toBe(clonerId);
    expect(after.rows[0].updated_at.getTime(), 'must not bump updated_at on idempotent re-run').toBe(
      firstUpdated.rows[0].updated_at.getTime(),
    );

    await cleanup(srcId, destId, ownerId);
  });
});
