import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock is hoisted before variable declarations, so mocks must use vi.fn() inline.
vi.mock('./neon-client.js', () => ({
  withNeonProjectLock: vi.fn().mockImplementation((_id: string, fn: () => Promise<void>) => fn()),
  deleteDatabase: vi.fn().mockResolvedValue(undefined),
  deleteProject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./neon-projects.js', () => ({ getDataProjectIdForRegion: vi.fn() }));

import { teardownAppDb } from './app-db-teardown.js';
import { withNeonProjectLock, deleteDatabase, deleteProject } from './neon-client.js';
import { getDataProjectIdForRegion } from './neon-projects.js';

const SHARED = 'shared-proj-us-east-1';
const REGION = 'us-east-1';

describe('teardownAppDb', () => {
  beforeEach(() => {
    vi.mocked(withNeonProjectLock)
      .mockReset()
      .mockImplementation((_id: string, fn: () => Promise<unknown>) => fn() as Promise<never>);
    vi.mocked(deleteDatabase).mockReset().mockResolvedValue(undefined);
    vi.mocked(deleteProject).mockReset().mockResolvedValue(undefined);
    vi.mocked(getDataProjectIdForRegion).mockReset().mockReturnValue(SHARED);
  });

  describe('legacy (project id === the region shared data project)', () => {
    it('deletes the database under the shared project lock, not the project', async () => {
      const res = await teardownAppDb({
        region: REGION,
        neonProjectId: SHARED,
        neonDatabaseName: 'cust_app_x',
      });

      expect(res).toEqual({
        mode: 'legacy',
        projectId: SHARED,
        databaseName: 'cust_app_x',
        alreadyGone: false,
      });
      expect(deleteDatabase).toHaveBeenCalledWith(SHARED, 'cust_app_x');
      expect(deleteProject).not.toHaveBeenCalled();
      expect(withNeonProjectLock).toHaveBeenCalledWith(SHARED, expect.any(Function));
    });

    it('treats a 404 from Neon as success', async () => {
      vi.mocked(deleteDatabase).mockRejectedValue(
        new Error('Neon API error 404 /projects/x/databases/cust_app_x'),
      );

      const res = await teardownAppDb({
        region: REGION,
        neonProjectId: SHARED,
        neonDatabaseName: 'cust_app_x',
      });

      expect(res.mode).toBe('legacy');
      expect(res.alreadyGone).toBe(true);
    });

    it('treats a "not found" message as success', async () => {
      vi.mocked(deleteDatabase).mockRejectedValue(new Error('database not found'));

      const res = await teardownAppDb({
        region: REGION,
        neonProjectId: SHARED,
        neonDatabaseName: 'cust_app_x',
      });

      expect(res.alreadyGone).toBe(true);
    });

    it('rethrows non-404 failures so callers keep their error contract', async () => {
      vi.mocked(deleteDatabase).mockRejectedValue(new Error('Neon API error 500'));

      await expect(
        teardownAppDb({ region: REGION, neonProjectId: SHARED, neonDatabaseName: 'cust_app_x' }),
      ).rejects.toThrow('Neon API error 500');
    });

    it('falls back to the shared project when the app has no stored project id', async () => {
      const res = await teardownAppDb({
        region: REGION,
        neonProjectId: null,
        neonDatabaseName: 'cust_app_x',
      });

      expect(res.mode).toBe('legacy');
      expect(deleteDatabase).toHaveBeenCalledWith(SHARED, 'cust_app_x');
      expect(deleteProject).not.toHaveBeenCalled();
    });

    it('stays legacy when the shared project id cannot be resolved', async () => {
      vi.mocked(getDataProjectIdForRegion).mockImplementation(() => {
        throw new Error('Missing env var NEON_DATA_PROJECT_ID_US_EAST_1 for region us-east-1');
      });

      const res = await teardownAppDb({
        region: REGION,
        neonProjectId: 'some-proj',
        neonDatabaseName: 'cust_app_x',
      });

      expect(res.mode).toBe('legacy');
      expect(deleteDatabase).toHaveBeenCalledWith('some-proj', 'cust_app_x');
      expect(deleteProject).not.toHaveBeenCalled();
    });
  });

  describe('tenant (project id !== the region shared data project)', () => {
    it('deletes the whole project, never the database inside it', async () => {
      const res = await teardownAppDb({
        region: REGION,
        neonProjectId: 'tenant-proj-9',
        neonDatabaseName: 'app_db',
      });

      expect(res).toEqual({ mode: 'tenant', projectId: 'tenant-proj-9', alreadyGone: false });
      expect(deleteProject).toHaveBeenCalledWith('tenant-proj-9');
      expect(deleteDatabase).not.toHaveBeenCalled();
    });

    it('treats a 404 from Neon as success', async () => {
      vi.mocked(deleteProject).mockRejectedValue(
        new Error('Neon API error 404 /projects/tenant-proj-9: not found'),
      );

      const res = await teardownAppDb({
        region: REGION,
        neonProjectId: 'tenant-proj-9',
        neonDatabaseName: 'app_db',
      });

      expect(res.mode).toBe('tenant');
      expect(res.alreadyGone).toBe(true);
    });

    it('rethrows non-404 failures', async () => {
      vi.mocked(deleteProject).mockRejectedValue(new Error('Neon API error 423 conflicting operations'));

      await expect(
        teardownAppDb({ region: REGION, neonProjectId: 'tenant-proj-9', neonDatabaseName: 'app_db' }),
      ).rejects.toThrow('423');
    });

    it('does not need a database name', async () => {
      const res = await teardownAppDb({ region: REGION, neonProjectId: 'tenant-proj-9' });

      expect(res.mode).toBe('tenant');
      expect(deleteProject).toHaveBeenCalledWith('tenant-proj-9');
    });

    it('is chosen from stored data, not the projectPerTenant flag', async () => {
      // config.neon.projectPerTenant is off in tests, yet a stored non-shared
      // project id must still take the tenant path — the flag can flip between
      // provisioning and deletion.
      const { config } = await import('../config.js');
      expect(config.neon.projectPerTenant).toBe(false);

      const res = await teardownAppDb({
        region: REGION,
        neonProjectId: 'tenant-proj-9',
        neonDatabaseName: 'app_db',
      });

      expect(res.mode).toBe('tenant');
    });
  });

  it('skips when there is nothing identifiable to delete', async () => {
    const res = await teardownAppDb({ region: REGION, neonProjectId: null, neonDatabaseName: null });

    expect(res).toEqual({ mode: 'skipped', alreadyGone: false });
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
  });
});
