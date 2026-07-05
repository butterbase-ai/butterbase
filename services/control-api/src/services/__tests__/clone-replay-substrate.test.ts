import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { replaySubstrateLink } from '../clone-replay.js';
import { runtimeDb, controlDb } from '../../__tests__/test-helpers/control-db.js';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;
const noopLogger = { info() {}, warn() {} };

describeDb('replaySubstrateLink', () => {
  async function seedApps(ownerId: string, slug: string, sourceSubstrateOrgId: string | null) {
    const srcId = `app_subs_src_${slug}`;
    const destId = `app_subs_dst_${slug}`;
    // Owner needs a personal org (NOT NULL post-orgs migration). Create it
    // first, then upsert the user pointing at it.
    const orgIns = await controlDb.query<{ id: string }>(
      `INSERT INTO organizations (owner_id, name, personal, plan_id, account_status)
       VALUES ($1, $2, true, 'playground', 'active')
       RETURNING id`,
      [ownerId, `subs-${slug}-org`],
    );
    const personalOrgId = orgIns.rows[0].id;
    await controlDb.query(
      `INSERT INTO platform_users (id, email, email_verified, personal_organization_id)
       VALUES ($1, $2, true, $3)
       ON CONFLICT (id) DO UPDATE SET personal_organization_id = EXCLUDED.personal_organization_id`,
      [ownerId, `subs-${ownerId}@x.com`, personalOrgId],
    );
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerId],
      );
    }
    await runtimeDb.query(
      `UPDATE apps SET substrate_organization_id = $1 WHERE id = $2`,
      [sourceSubstrateOrgId, srcId],
    );
    await runtimeDb.query(
      `UPDATE apps SET substrate_organization_id = NULL WHERE id = $1`,
      [destId],
    );
    return { srcId, destId };
  }

  async function cleanup(srcId: string, destId: string, ownerId: string) {
    await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
    // Delete order: user first (its personal_organization_id references the
    // org), then the org itself.
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
    await controlDb.query(`DELETE FROM organizations WHERE owner_id = $1 AND personal = true`, [ownerId]);
  }

  it('links the dest to the cloner org when source had any substrate link', async () => {
    const ownerId = randomUUID();
    const clonerOrgId = randomUUID();
    const sourceSubstrateOrgId = randomUUID();
    const slug = ownerId.slice(0, 8);
    const { srcId, destId } = await seedApps(ownerId, slug, sourceSubstrateOrgId);

    const result = await replaySubstrateLink(runtimeDb, runtimeDb, srcId, destId, clonerOrgId, noopLogger);
    expect(result.warnings).toEqual([]);

    const row = await runtimeDb.query<{ substrate_organization_id: string | null }>(
      `SELECT substrate_organization_id FROM apps WHERE id = $1`,
      [destId],
    );
    expect(row.rows[0].substrate_organization_id, 'dest must link to cloner org, not source').toBe(clonerOrgId);
    expect(row.rows[0].substrate_organization_id).not.toBe(sourceSubstrateOrgId);

    await cleanup(srcId, destId, ownerId);
  });

  it('is a no-op when source was never linked', async () => {
    const ownerId = randomUUID();
    const clonerOrgId = randomUUID();
    const slug = ownerId.slice(0, 8);
    const { srcId, destId } = await seedApps(ownerId, slug, null);

    const result = await replaySubstrateLink(runtimeDb, runtimeDb, srcId, destId, clonerOrgId, noopLogger);
    expect(result.warnings).toEqual([]);

    const row = await runtimeDb.query<{ substrate_organization_id: string | null }>(
      `SELECT substrate_organization_id FROM apps WHERE id = $1`,
      [destId],
    );
    expect(row.rows[0].substrate_organization_id, 'dest must stay NULL when source had no link').toBeNull();

    await cleanup(srcId, destId, ownerId);
  });

  it('is idempotent: re-running does not overwrite if dest already linked to cloner org', async () => {
    const ownerId = randomUUID();
    const clonerOrgId = randomUUID();
    const sourceSubstrateOrgId = randomUUID();
    const slug = ownerId.slice(0, 8);
    const { srcId, destId } = await seedApps(ownerId, slug, sourceSubstrateOrgId);

    await replaySubstrateLink(runtimeDb, runtimeDb, srcId, destId, clonerOrgId, noopLogger);
    const firstUpdated = await runtimeDb.query<{ updated_at: Date }>(
      `SELECT updated_at FROM apps WHERE id = $1`,
      [destId],
    );

    // Sleep a tick so a second UPDATE would visibly bump updated_at if it ran.
    await new Promise((r) => setTimeout(r, 50));

    const second = await replaySubstrateLink(runtimeDb, runtimeDb, srcId, destId, clonerOrgId, noopLogger);
    expect(second.warnings).toEqual([]);

    const after = await runtimeDb.query<{ substrate_organization_id: string | null; updated_at: Date }>(
      `SELECT substrate_organization_id, updated_at FROM apps WHERE id = $1`,
      [destId],
    );
    expect(after.rows[0].substrate_organization_id).toBe(clonerOrgId);
    expect(after.rows[0].updated_at.getTime(), 'must not bump updated_at on idempotent re-run').toBe(
      firstUpdated.rows[0].updated_at.getTime(),
    );

    await cleanup(srcId, destId, ownerId);
  });
});
