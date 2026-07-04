// Mock @butterbase/shared before any other imports — the package's dist/ is not
// built in the OSS dev environment, so Vite cannot resolve it. We only need
// the two symbols that config.ts imports from it.
import { vi } from 'vitest';
vi.mock('@butterbase/shared', () => ({
  loadRegionConfig: () => ({ instanceRegion: 'us-east-1', regions: ['us-east-1'], flyRegionMap: {} }),
  regionToEnvSuffix: (r: string) => r.replace(/-/g, '_').toUpperCase(),
}));

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import pg from 'pg';
import { billingRoutes } from '../routes/billing.js';
import { controlDb, runtimeDb, setupTestDb, seedUser } from './test-helpers/control-db.js';

/** Insert a non-personal org directly (owner already has a personal org so
 *  ensurePersonalOrg would hit the one_personal_per_owner constraint). */
async function insertNonPersonalOrg(ownerId: string, name: string): Promise<string> {
  const { rows } = await controlDb.query<{ id: string }>(
    `INSERT INTO organizations (owner_id, name, personal, plan_id, credits_usd, auto_refill_enabled, account_status)
     VALUES ($1, $2, false, 'playground', 0, false, 'active')
     RETURNING id`,
    [ownerId, name],
  );
  return rows[0]!.id;
}

describe('DELETE /dashboard/account — user-delete guard', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    (app as unknown as { controlDb: pg.Pool }).controlDb = controlDb;
    // runtimeDb is used by the handler to look up owned apps. Use the real
    // runtime pool so that the `SELECT … FROM apps` query resolves.
    (app as unknown as { runtimeDb: (_: string) => pg.Pool }).runtimeDb = () => runtimeDb;
    // Stub auth so that request.auth.userId is populated from the x-test-user header.
    app.addHook('preHandler', async (req) => {
      const testUser = (req.headers['x-test-user'] as string | undefined) ?? null;
      (req as unknown as { auth: { userId: string } }).auth = { userId: testUser as string };
    });
    await app.register(billingRoutes);
    await app.ready();
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => { await setupTestDb(); });

  it('refuses to delete when user is sole owner of a non-personal org (409)', async () => {
    const { id: userId } = await seedUser('sole-owner-guard@x.com');
    // Insert a non-personal org directly (user already has a personal org from seedUser).
    const nonPersonalOrgId = await insertNonPersonalOrg(userId, 'sole-owner-test-org');
    // Add owner membership for the non-personal org.
    await controlDb.query(
      `INSERT INTO organization_members (organization_id, user_id, role, joined_at)
       VALUES ($1, $2, 'owner', now())
       ON CONFLICT DO NOTHING`,
      [nonPersonalOrgId, userId],
    );

    const res = await app.inject({
      method: 'DELETE',
      url: '/dashboard/account',
      headers: { 'x-test-user': userId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'sole_owner_of_org' });
  });

  it('deletes when user owns only their personal org (200) and cleans up the personal org row', async () => {
    const { id: userId, personalOrgId } = await seedUser('personal-only@x.com');

    const res = await app.inject({
      method: 'DELETE',
      url: '/dashboard/account',
      headers: { 'x-test-user': userId },
    });
    expect(res.statusCode).toBe(200);

    // platform_users row gone
    const u = await controlDb.query(`SELECT 1 FROM platform_users WHERE id = $1`, [userId]);
    expect(u.rows.length).toBe(0);

    // Personal org cleaned up
    const o = await controlDb.query(`SELECT 1 FROM organizations WHERE id = $1`, [personalOrgId]);
    expect(o.rows.length).toBe(0);
  });

  it('deletes when user is a NON-owner member of another org (200)', async () => {
    const { id: userId } = await seedUser('member-only@x.com');
    const { id: otherId } = await seedUser('other-owner@x.com');
    // Insert a non-personal org owned by otherId.
    const orgId = await insertNonPersonalOrg(otherId, 'shared-non-personal-org');
    await controlDb.query(
      `INSERT INTO organization_members (organization_id, user_id, role, joined_at)
       VALUES ($1, $2, 'owner', now()),
              ($1, $3, 'member', now())`,
      [orgId, otherId, userId],
    );

    const res = await app.inject({
      method: 'DELETE',
      url: '/dashboard/account',
      headers: { 'x-test-user': userId },
    });
    expect(res.statusCode).toBe(200);
  });
});
