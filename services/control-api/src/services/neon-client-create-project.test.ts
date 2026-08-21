import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildCreateProjectBody, projectNameForApp, createProjectForApp, findProjectByName } from './neon-client.js';

describe('projectNameForApp', () => {
  it('prefixes the app id so the reconciler can search for it', () => {
    expect(projectNameForApp('app_k3f9x2m1qp0z', 'us-east-1')).toBe('bb-app_k3f9x2m1qp0z-us-east-1');
  });

  it('suffixes the region so a moved app cannot collide with its retained source', () => {
    expect(projectNameForApp('app_x', 'us-west-2')).toBe('bb-app_x-us-west-2');
    expect(projectNameForApp('app_x', 'us-west-2')).not.toBe(projectNameForApp('app_x', 'us-east-1'));
  });
});

describe('buildCreateProjectBody', () => {
  const params = {
    appId: 'app_k3f9x2m1qp0z',
    region: 'us-east-1',
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

    expect(body.project.name).toBe('bb-app_k3f9x2m1qp0z-us-east-1');
    expect(body.project.org_id).toBe('org-round-cell-11808374');
    expect(body.project.region_id).toBe('aws-us-east-1');
    expect(body.project.pg_version).toBe(17);
    expect(body.project.branch.database_name).toBe('db_app_k3f9x2m1qp0z');
    expect(body.project.branch.role_name).toBe('butterbase');
  });

  it('keeps the region-scoped name and the Neon region id as separate fields', () => {
    const body = buildCreateProjectBody({
      ...params,
      region: 'us-west-2',
      neonRegionId: 'aws-us-west-2',
    }) as { project: { name: string; region_id: string } };

    expect(body.project.name).toBe('bb-app_k3f9x2m1qp0z-us-west-2');
    expect(body.project.region_id).toBe('aws-us-west-2');
  });

  it('omits org_id when none is configured rather than sending an empty string', () => {
    const body = buildCreateProjectBody({ ...params, orgId: '' }) as {
      project: Record<string, unknown>;
    };
    expect('org_id' in body.project).toBe(false);
  });
});

describe('createProjectForApp retry semantics', () => {
  const params = {
    appId: 'app_k3f9x2m1qp0z',
    region: 'us-east-1',
    neonRegionId: 'aws-us-east-1',
    databaseName: 'db_app_k3f9x2m1qp0z',
    ownerRole: 'butterbase',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does NOT retry POST /projects on a network error (a retry would double-bill a project)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createProjectForApp(params)).rejects.toThrow('ECONNRESET');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry POST /projects on a 5xx — Neon may already have created it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('bad gateway', { status: 502 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(createProjectForApp(params)).rejects.toThrow('Neon API error 502');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('issues exactly one POST on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          project: { id: 'proj-123' },
          connection_uris: [{ connection_uri: 'postgresql://u:p@host/db' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const created = await createProjectForApp(params);
    expect(created.projectId).toBe('proj-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  it('still retries idempotent GETs (opt-out is scoped to project creation)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [{ id: 'proj-9', name: 'bb-app_x' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(findProjectByName('bb-app_x')).resolves.toEqual({ id: 'proj-9' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
