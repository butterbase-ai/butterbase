import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resolveOrganizationId } from '../services/org-resolver.js';
import { controlDb, setupTestDb, seedUser } from './test-helpers/control-db.js';

describe('resolveOrganizationId', () => {
  beforeAll(async () => { await setupTestDb(); });
  beforeEach(async () => { await setupTestDb(); });
  afterAll(async () => { await controlDb.end(); });

  it('returns personal_organization_id for a seeded user', async () => {
    const { id: userId, personalOrgId } = await seedUser('resolver-ok@x.com');
    const resolved = await resolveOrganizationId(controlDb, userId);
    expect(resolved).toBe(personalOrgId);
  });

  it('throws when the user does not exist', async () => {
    const bogus = '00000000-0000-0000-0000-000000000000';
    await expect(resolveOrganizationId(controlDb, bogus)).rejects.toThrow(/not found/);
  });

  it('throws when personal_organization_id is NULL (should be impossible post-Plan-05)', async () => {
    // Insert a row bypassing seedUser's transaction so personal_organization_id
    // is NULL. This shape does not exist in prod but proves the guard fires.
    // Note: after migration 076, NOT NULL is enforced at DB level, so we must
    // rely on temporarily dropping the constraint to write a null row. Instead,
    // simulate by pointing the query at a nonexistent row via a mocked pool.
    const mockPool = {
      query: async () => ({ rows: [{ personal_organization_id: null }] }),
    } as unknown as Parameters<typeof resolveOrganizationId>[0];
    await expect(resolveOrganizationId(mockPool, 'anyuser')).rejects.toThrow(/no personal_organization_id/);
  });
});
