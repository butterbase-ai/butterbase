import { describe, it, expect } from 'vitest';
import { buildCreateProjectBody, projectNameForApp } from './neon-client.js';

describe('projectNameForApp', () => {
  it('prefixes the app id so the reconciler can search for it', () => {
    expect(projectNameForApp('app_k3f9x2m1qp0z')).toBe('bb-app_k3f9x2m1qp0z');
  });
});

describe('buildCreateProjectBody', () => {
  const params = {
    appId: 'app_k3f9x2m1qp0z',
    neonRegionId: 'aws-us-east-1',
    databaseName: 'db_app_k3f9x2m1qp0z',
    ownerRole: 'butterbase',
    orgId: 'org-round-cell-11808374',
    pgVersion: 17,
  };

  it('creates project, database and role in a single request body', () => {
    const body = buildCreateProjectBody(params) as {
      project: {
        name: string; org_id: string; region_id: string; pg_version: number;
        branch: { database_name: string; role_name: string };
      };
    };

    expect(body.project.name).toBe('bb-app_k3f9x2m1qp0z');
    expect(body.project.org_id).toBe('org-round-cell-11808374');
    expect(body.project.region_id).toBe('aws-us-east-1');
    expect(body.project.pg_version).toBe(17);
    expect(body.project.branch.database_name).toBe('db_app_k3f9x2m1qp0z');
    expect(body.project.branch.role_name).toBe('butterbase');
  });

  it('omits org_id when none is configured rather than sending an empty string', () => {
    const body = buildCreateProjectBody({ ...params, orgId: '' }) as {
      project: Record<string, unknown>;
    };
    expect('org_id' in body.project).toBe(false);
  });
});
