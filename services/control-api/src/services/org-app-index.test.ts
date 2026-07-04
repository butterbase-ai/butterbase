import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  addOrgAppIndex,
  removeOrgAppIndex,
  updateOrgAppIndexRegion,
  listUserApps,
} from './org-app-index.js';
import { controlDb, setupTestDb, seedUser } from '../__tests__/test-helpers/control-db.js';

let testUserId: string;
let personalOrgId: string;

beforeAll(async () => {
  await setupTestDb();
  const seeded = await seedUser('uai-test@example.com');
  testUserId = seeded.id;
  personalOrgId = seeded.personalOrgId;
});

afterAll(async () => {
  await controlDb.query(`DELETE FROM org_app_index WHERE organization_id = $1`, [personalOrgId]);
  await controlDb.end();
});

beforeEach(async () => {
  await controlDb.query(`DELETE FROM org_app_index WHERE organization_id = $1`, [personalOrgId]);
});

describe('addOrgAppIndex', () => {
  it("inserts a new row stamped with the caller's personal_organization_id", async () => {
    await addOrgAppIndex(controlDb, { organizationId: personalOrgId, appId: 'app-1', region: 'us-east-1', subdomain: 'demo', appName: 'Demo' });
    const apps = await listUserApps(controlDb, personalOrgId);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      app_id: 'app-1',
      region: 'us-east-1',
      subdomain: 'demo',
      organization_id: personalOrgId,
    });
  });

  it("is idempotent on duplicate insert; org id remains the caller's org", async () => {
    await addOrgAppIndex(controlDb, { organizationId: personalOrgId, appId: 'app-1', region: 'us-east-1' });
    await addOrgAppIndex(controlDb, { organizationId: personalOrgId, appId: 'app-1', region: 'us-east-1' });
    const apps = await listUserApps(controlDb, personalOrgId);
    expect(apps).toHaveLength(1);
    expect(apps[0].organization_id).toBe(personalOrgId);
  });

  it('throws when the organizationId has no organizations row (FK violation)', async () => {
    const bogus = '00000000-0000-0000-0000-000000000000';
    await expect(
      addOrgAppIndex(controlDb, { organizationId: bogus, appId: 'app-x', region: 'us-east-1' }),
    ).rejects.toThrow();
  });
});

describe('removeOrgAppIndex', () => {
  it('deletes the row', async () => {
    await addOrgAppIndex(controlDb, { organizationId: personalOrgId, appId: 'app-1', region: 'us-east-1' });
    await removeOrgAppIndex(controlDb, 'app-1');
    const apps = await listUserApps(controlDb, personalOrgId);
    expect(apps).toHaveLength(0);
  });

  it('is a no-op for unknown app', async () => {
    await expect(removeOrgAppIndex(controlDb, 'never-existed')).resolves.not.toThrow();
  });
});

describe('updateOrgAppIndexRegion', () => {
  it('updates the region of an existing entry', async () => {
    await addOrgAppIndex(controlDb, { organizationId: personalOrgId, appId: 'app-1', region: 'us-east-1' });
    await updateOrgAppIndexRegion(controlDb, 'app-1', 'eu-west-1');
    const apps = await listUserApps(controlDb, personalOrgId);
    expect(apps[0].region).toBe('eu-west-1');
  });
});

describe('listUserApps', () => {
  it('returns rows for the org, newest first, each carrying organization_id', async () => {
    await addOrgAppIndex(controlDb, { organizationId: personalOrgId, appId: 'a', region: 'us-east-1' });
    await new Promise((r) => setTimeout(r, 10));
    await addOrgAppIndex(controlDb, { organizationId: personalOrgId, appId: 'b', region: 'us-east-1' });
    const apps = await listUserApps(controlDb, personalOrgId);
    expect(apps.map((a) => a.app_id)).toEqual(['b', 'a']);
    expect(apps.every((a) => a.organization_id === personalOrgId)).toBe(true);
  });
});
