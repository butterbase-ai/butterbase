import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { provisionNeonDbForApp, type ProvisionDeps } from './app-db-provision.js';
import { config } from '../config.js';

const APP_ID = 'app_k3f9x2m1qp0z';
const REGION = 'us-east-1';

/** Records every dependency call so tests can assert what was and was NOT called. */
function makeDeps(overrides: Partial<ProvisionDeps> = {}) {
  const calls: string[] = [];
  const createProjectForAppCalls: Parameters<ProvisionDeps['createProjectForApp']>[0][] = [];
  const deps: ProvisionDeps = {
    createProjectForApp: async (p) => {
      calls.push('createProjectForApp');
      createProjectForAppCalls.push(p);
      return { projectId: 'tenant-proj-1', databaseName: p.databaseName, connectionUri: 'postgres://u:p@direct/db' };
    },
    ensureRoleExists: async () => { calls.push('ensureRoleExists'); },
    createDatabase: async () => { calls.push('createDatabase'); return null; },
    grantSchemaPrivileges: async () => { calls.push('grantSchemaPrivileges'); },
    withNeonProjectLock: async (_id, fn) => { calls.push('withNeonProjectLock'); return fn(); },
    getConnectionString: async () => {
      calls.push('getConnectionString');
      return {
        connectionUri: 'postgres://u:p@direct/db',
        poolerHost: 'ep-x-pooler.us-east-1.aws.neon.tech',
        pooledConnectionUri: 'postgres://u:p@ep-x-pooler.us-east-1.aws.neon.tech/db',
      };
    },
    waitUntilUriQueryable: async () => { calls.push('waitUntilUriQueryable'); },
    getDataProjectIdForRegion: () => 'shared-proj-us-east-1',
    getNeonRegionIdForRegion: () => 'aws-us-east-1',
    getNeonPgVersionForRegion: () => 18,
    findProjectByName: async () => { calls.push('findProjectByName'); return null; },
    ...overrides,
  };
  return { deps, calls, createProjectForAppCalls };
}

describe('provisionNeonDbForApp', () => {
  const original = config.neon.projectPerTenant;
  afterEach(() => { config.neon.projectPerTenant = original; });

  describe('tenant mode (projectPerTenant = true)', () => {
    beforeEach(() => { config.neon.projectPerTenant = true; });

    it('creates a dedicated project and returns its id', async () => {
      const { deps } = makeDeps();
      const result = await provisionNeonDbForApp(REGION, APP_ID, deps);

      expect(result.neonProjectId).toBe('tenant-proj-1');
      expect(result.neonDatabaseName).toBe(`db_${APP_ID}`);
      expect(result.connectionUri).toBe('postgres://u:p@direct/db');
    });

    it('NEVER calls grantSchemaPrivileges — the owning role already has schema rights', async () => {
      const { deps, calls } = makeDeps();
      await provisionNeonDbForApp(REGION, APP_ID, deps);
      expect(calls).not.toContain('grantSchemaPrivileges');
    });

    it('NEVER calls ensureRoleExists — the role is created by POST /projects', async () => {
      const { deps, calls } = makeDeps();
      await provisionNeonDbForApp(REGION, APP_ID, deps);
      expect(calls).not.toContain('ensureRoleExists');
    });

    it('does not take the project lock — a new project has no conflicting operations', async () => {
      const { deps, calls } = makeDeps();
      await provisionNeonDbForApp(REGION, APP_ID, deps);
      expect(calls).not.toContain('withNeonProjectLock');
    });

    it('waits for the database to become queryable before returning', async () => {
      const { deps, calls } = makeDeps();
      await provisionNeonDbForApp(REGION, APP_ID, deps);
      expect(calls).toContain('waitUntilUriQueryable');
    });

    it('returns the pooled connection string when one is available', async () => {
      const { deps } = makeDeps();
      const result = await provisionNeonDbForApp(REGION, APP_ID, deps);
      expect(result.poolerConnectionString).toBe('postgres://u:p@ep-x-pooler.us-east-1.aws.neon.tech/db');
    });

    it('tolerates the pooled lookup failing — the direct URI is enough to serve', async () => {
      const { deps } = makeDeps({
        getConnectionString: async () => { throw new Error('pooler lookup exploded'); },
      });
      const result = await provisionNeonDbForApp(REGION, APP_ID, deps);
      expect(result.poolerConnectionString).toBeNull();
      expect(result.connectionUri).toBe('postgres://u:p@direct/db');
    });

    it('adopts an existing project instead of creating a duplicate on retry', async () => {
      const { deps, calls } = makeDeps({
        findProjectByName: async () => ({ id: 'already-there' }),
      });

      const result = await provisionNeonDbForApp(REGION, APP_ID, deps);

      expect(result.neonProjectId).toBe('already-there');
      expect(calls).not.toContain('createProjectForApp');
    });

    it('creates a project when none exists yet', async () => {
      const { deps, calls } = makeDeps({ findProjectByName: async () => null });
      const result = await provisionNeonDbForApp(REGION, APP_ID, deps);

      expect(result.neonProjectId).toBe('tenant-proj-1');
      expect(calls).toContain('createProjectForApp');
    });

    it('passes the per-region pgVersion through to createProjectForApp', async () => {
      const { deps, createProjectForAppCalls } = makeDeps({
        getNeonPgVersionForRegion: () => 18,
      });
      await provisionNeonDbForApp(REGION, APP_ID, deps);

      expect(createProjectForAppCalls).toHaveLength(1);
      expect(createProjectForAppCalls[0]?.pgVersion).toBe(18);
    });
  });

  describe('legacy mode (projectPerTenant = false)', () => {
    beforeEach(() => { config.neon.projectPerTenant = false; });

    it('creates a database inside the shared project, under the lock', async () => {
      const { deps, calls } = makeDeps();
      const result = await provisionNeonDbForApp(REGION, APP_ID, deps);

      expect(result.neonProjectId).toBe('shared-proj-us-east-1');
      expect(calls).toContain('withNeonProjectLock');
      expect(calls).toContain('ensureRoleExists');
      expect(calls).toContain('createDatabase');
      expect(calls).toContain('grantSchemaPrivileges');
    });

    it('never creates a project', async () => {
      const { deps, calls } = makeDeps();
      await provisionNeonDbForApp(REGION, APP_ID, deps);
      expect(calls).not.toContain('createProjectForApp');
    });
  });
});
