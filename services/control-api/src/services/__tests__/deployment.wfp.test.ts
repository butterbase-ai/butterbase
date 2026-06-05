import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';

// Ensure AUTH_ENCRYPTION_KEY is set for the reader — writer/reader symmetry requires env var.
process.env.AUTH_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Mock config before importing module under test
vi.mock('../../config.js', () => ({
  config: {
    cloudflare: {
      enabled: true,
      accountId: 'acc123',
      apiToken: 'tok123',
      dispatchNamespace: 'bb-frontends',
      subdomainKvId: 'kv123',
      zoneId: 'zone123',
      defaultDomain: 'butterbase.pages.dev',
      dispatchWorkerName: 'bb-dispatch',
    },
    subdomain: {
      baseDomain: 'butterbase.dev',
      enabled: true,
    },
    deployment: {
      defaultBackend: 'pages',
    },
    auth: {
      encryptionKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    runtimeDb: { urlsByRegion: { local: 'postgres://test' } },
  },
  assertRegionConfig: () => ({ instanceRegion: 'local' }),
}));

// Phase 2: mock runtime-db so getRuntimeDbPool returns the same mock db the
// tests already inject via the `db` argument. This lets existing test assertions
// on db.query.mock.calls keep working without rewriting every test.
vi.mock('../runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(),
}));

// Mock R2
vi.mock('../r2.js', () => ({
  generatePresignedUploadUrl: vi.fn(),
  downloadObjectAsBuffer: vi.fn(),
  deleteObject: vi.fn().mockResolvedValue(undefined),
}));

// Mock cloudflare-pages
vi.mock('../cloudflare-pages.js', () => ({
  CloudflareError: class CloudflareError extends Error {
    constructor(public statusCode: number, message: string) {
      super(message);
    }
  },
  getProject: vi.fn(),
  createProject: vi.fn(),
  createDeployment: vi.fn(),
  cancelDeployment: vi.fn(),
  createDnsRecord: vi.fn(),
  addCustomDomain: vi.fn(),
  removeCustomDomain: vi.fn(),
  deleteProject: vi.fn(),
  deleteDnsRecord: vi.fn(),
  getDeployment: vi.fn(),
}));

// Mock cloudflare-wfp
vi.mock('../cloudflare-wfp.js', () => ({
  PLACEHOLDER_SCRIPT_NAME: '__placeholder__',
  deployUserWorker: vi.fn().mockResolvedValue(undefined),
  writeSubdomainMapping: vi.fn().mockResolvedValue(undefined),
  deleteUserWorker: vi.fn().mockResolvedValue(undefined),
  deleteDoWorker: vi.fn().mockResolvedValue(undefined),
  deleteSubdomainMapping: vi.fn().mockResolvedValue(undefined),
}));

// Mock failure-notifications so email-service (which reads config.ses at load time) is never imported.
vi.mock('../failure-notifications.service.js', () => ({
  notifyDeploymentFailed: vi.fn(() => Promise.resolve()),
}));

import * as R2 from '../r2.js';
import * as CloudflarePages from '../cloudflare-pages.js';
import * as CloudflareWfp from '../cloudflare-wfp.js';
import * as RuntimeDb from '../runtime-db.js';
import { runDeploymentPipeline } from '../deployment.service.js';
import { encrypt } from '../crypto.js';

function makeZipBuffer(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.from(content));
  }
  return zip.toBuffer();
}

interface MockDb {
  query: ReturnType<typeof vi.fn>;
}

function makeDb(appRow: Record<string, unknown>, envVarRows: Array<{ key: string; encrypted_value: string }> = []): MockDb {
  return {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ').toLowerCase();
      if (normalized.includes('from apps') && normalized.includes('where id')) {
        return { rows: [appRow] };
      }
      if (normalized.includes('from app_frontend_env_vars')) {
        return { rows: envVarRows };
      }
      if (normalized.includes('from app_deployments') && normalized.includes('order by created_at desc')) {
        return { rows: [] };
      }
      // Phase 2: cleanupOldDeployments first queries apps for owner_id on runtimePool,
      // then queries platform_users JOIN plans on controlPool.
      if (normalized.includes('select owner_id from apps')) {
        return { rows: [{ owner_id: 'owner_1' }] };
      }
      if (normalized.includes('from platform_users') && normalized.includes('plans')) {
        return { rows: [{ max_deployments: 10 }] };
      }
      // Default: UPDATE / DELETE
      return { rows: [] };
    }),
  };
}

// Helper: wire getRuntimeDbPool to return the given mock db so that runtime-tier
// queries flow through the same vi.fn as the test argument, preserving assertions.
function wireRuntimeDb(mockDb: unknown): void {
  (RuntimeDb.getRuntimeDbPool as ReturnType<typeof vi.fn>).mockReturnValue(mockDb);
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('runDeploymentPipeline (WfP branch)', () => {
  it('deploys via WfP when app.deployment_backend=wfp', async () => {
    const zipBuffer = makeZipBuffer({
      'index.html': '<html>hi</html>',
      'assets/app.js': 'console.log(1)',
    });
    (R2.downloadObjectAsBuffer as ReturnType<typeof vi.fn>).mockResolvedValue(zipBuffer);

    const encKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const encryptedVal = encrypt('https://api.example.com', encKey);

    const db = makeDb(
      {
        name: 'My App',
        subdomain: 'myapp',
        cloudflare_project_name: null,
        deployment_backend: 'wfp',
      },
      [{ key: 'VITE_API_URL', encrypted_value: encryptedVal }]
    );

    wireRuntimeDb(db);
    await runDeploymentPipeline(
      db as unknown as import('pg').Pool,
      'app_abc',
      'dep_1',
      { r2_object_key: 'r2/key', framework: 'react-vite' }
    );

    // WfP was called
    expect(CloudflareWfp.deployUserWorker).toHaveBeenCalledTimes(1);
    const call = (CloudflareWfp.deployUserWorker as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.scriptName).toBe('app_abc');
    expect(call.files).toBeInstanceOf(Map);
    expect(call.files.size).toBeGreaterThan(0);
    // Keys normalized with leading slash + forward slashes
    expect([...call.files.keys()].every((k: string) => k.startsWith('/') && !k.includes('\\'))).toBe(true);
    expect(call.envVars).toEqual({ VITE_API_URL: 'https://api.example.com' });

    // Subdomain mapping written
    expect(CloudflareWfp.writeSubdomainMapping).toHaveBeenCalledWith('myapp', 'app_abc', 'local');

    // Pages NOT called
    expect(CloudflarePages.createDeployment).not.toHaveBeenCalled();

    // DB UPDATE sets deployment_url to https://{subdomain}.{baseDomain} AND status READY
    const updateCall = db.query.mock.calls.find(([sql]) =>
      typeof sql === 'string' && /update app_deployments/i.test(sql) && /deployment_url/i.test(sql)
    );
    expect(updateCall).toBeDefined();
    const [, params] = updateCall!;
    expect(params).toContain('https://myapp.butterbase.dev');

    // Status should be READY (end state), no BUILDING for WfP
    const statusUpdates = db.query.mock.calls
      .filter(([sql]) => typeof sql === 'string' && /update app_deployments/i.test(sql))
      .map(([sql, params]) => ({ sql, params }));
    const allParamsFlat = statusUpdates.flatMap((u) => u.params as unknown[]);
    expect(allParamsFlat).toContain('READY');
  });

  it('strips /_redirects from the fileMap before calling deployUserWorker', async () => {
    const zipBuffer = makeZipBuffer({
      'index.html': '<html>hi</html>',
      '_redirects': '/old /new 301\n/* /index.html 200\n',
    });
    (R2.downloadObjectAsBuffer as ReturnType<typeof vi.fn>).mockResolvedValue(zipBuffer);

    const db = makeDb({
      name: 'My App',
      subdomain: 'myapp',
      cloudflare_project_name: null,
      deployment_backend: 'wfp',
    });

    wireRuntimeDb(db);
    await runDeploymentPipeline(
      db as unknown as import('pg').Pool,
      'app_abc',
      'dep_redirects',
      { r2_object_key: 'r2/key', framework: 'react-vite' }
    );

    expect(CloudflareWfp.deployUserWorker).toHaveBeenCalledTimes(1);
    const call = (CloudflareWfp.deployUserWorker as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // _redirects must not appear in the uploaded bundle — it was parsed into
    // BB_REDIRECTS_RULES and stripped so it doesn't leak routing config.
    expect(call.files.has('/_redirects')).toBe(false);
    // But the rest of the files should still be present.
    expect(call.files.has('/index.html')).toBe(true);
  });

  it('supersedes active app_edge_ssr_deployments rows when WfP static deploy reaches READY', async () => {
    const zipBuffer = makeZipBuffer({
      'index.html': '<html>hi</html>',
    });
    (R2.downloadObjectAsBuffer as ReturnType<typeof vi.fn>).mockResolvedValue(zipBuffer);

    const db = makeDb({
      name: 'My App',
      subdomain: 'myapp',
      cloudflare_project_name: null,
      deployment_backend: 'wfp',
    });

    wireRuntimeDb(db);
    await runDeploymentPipeline(
      db as unknown as import('pg').Pool,
      'app_abc',
      'dep_supersede',
      { r2_object_key: 'r2/key', framework: 'react-vite' }
    );

    // Must have issued the edge SSR supersede UPDATE
    const supersedeSsrCall = (db.query as ReturnType<typeof vi.fn>).mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        /update app_edge_ssr_deployments/i.test(sql) &&
        /status = 'superseded'/i.test(sql)
    );
    expect(supersedeSsrCall).toBeDefined();
    // Scoped to the correct app_id
    expect(supersedeSsrCall![1]).toEqual(['app_abc']);
  });

  it('does NOT supersede app_edge_ssr_deployments when app uses Pages backend', async () => {
    const zipBuffer = makeZipBuffer({ 'index.html': '<html>hi</html>' });
    (R2.downloadObjectAsBuffer as ReturnType<typeof vi.fn>).mockResolvedValue(zipBuffer);
    (CloudflarePages.createDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'cf_dep_x',
      url: 'https://foo.pages.dev',
    });
    (CloudflarePages.getProject as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'proj' });

    const db = makeDb({
      name: 'My App',
      subdomain: 'myapp',
      cloudflare_project_name: 'bb-my-app',
      deployment_backend: 'pages',
    });

    wireRuntimeDb(db);
    await runDeploymentPipeline(
      db as unknown as import('pg').Pool,
      'app_abc',
      'dep_pages',
      { r2_object_key: 'r2/key', framework: 'react-vite' }
    );

    // Pages deploy reaches BUILDING, NOT READY — no SSR supersede should fire
    const supersedeSsrCall = (db.query as ReturnType<typeof vi.fn>).mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        /update app_edge_ssr_deployments/i.test(sql)
    );
    expect(supersedeSsrCall).toBeUndefined();
  });

  it('deploys via Pages when app.deployment_backend=pages', async () => {
    const zipBuffer = makeZipBuffer({ 'index.html': '<html>hi</html>' });
    (R2.downloadObjectAsBuffer as ReturnType<typeof vi.fn>).mockResolvedValue(zipBuffer);
    (CloudflarePages.createDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'cf_dep_1',
      url: 'https://foo.pages.dev',
    });
    (CloudflarePages.getProject as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'proj' });

    const db = makeDb({
      name: 'My App',
      subdomain: 'myapp',
      cloudflare_project_name: 'bb-my-app',
      deployment_backend: 'pages',
    });

    wireRuntimeDb(db);
    await runDeploymentPipeline(
      db as unknown as import('pg').Pool,
      'app_abc',
      'dep_1',
      { r2_object_key: 'r2/key', framework: 'react-vite' }
    );

    expect(CloudflarePages.createDeployment).toHaveBeenCalledTimes(1);
    expect(CloudflareWfp.deployUserWorker).not.toHaveBeenCalled();
    expect(CloudflareWfp.writeSubdomainMapping).not.toHaveBeenCalled();
  });
});

describe('deployTemplatePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('takes the WfP path when app.deployment_backend=wfp', async () => {
    const { deployTemplatePage } = await import('../deployment.service.js');

    const dbMock = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (/FROM apps WHERE id/i.test(sql)) {
          return Promise.resolve({
            rows: [{ deployment_backend: 'wfp' }],
          });
        }
        if (/INSERT INTO app_deployments/i.test(sql)) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as import('pg').Pool;

    wireRuntimeDb(dbMock);
    const result = await deployTemplatePage(
      dbMock,
      'app_abc',
      'myapp',
      'My App',
      'user_1',
    );

    expect(result).toBe('__placeholder__');
    expect(CloudflareWfp.writeSubdomainMapping).toHaveBeenCalledWith(
      'myapp',
      '__placeholder__',
      'local',
    );
    expect(CloudflarePages.createProject).not.toHaveBeenCalled();
    expect(CloudflarePages.createDeployment).not.toHaveBeenCalled();
    expect(CloudflarePages.createDnsRecord).not.toHaveBeenCalled();
    expect(CloudflarePages.addCustomDomain).not.toHaveBeenCalled();

    const insertCall = (dbMock.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => /INSERT INTO app_deployments/i.test(c[0] as string),
    );
    expect(insertCall).toBeDefined();
  });

  it('takes the Pages path when app.deployment_backend=pages', async () => {
    vi.mocked(CloudflarePages.getProject).mockRejectedValueOnce(
      new (CloudflarePages as any).CloudflareError(404, 'not found'),
    );
    vi.mocked(CloudflarePages.createProject).mockResolvedValueOnce(undefined as any);
    vi.mocked(CloudflarePages.createDeployment).mockResolvedValueOnce({
      id: 'cf_dep_1',
      url: 'https://bb-myapp.pages.dev',
    } as any);
    vi.mocked(CloudflarePages.createDnsRecord).mockResolvedValueOnce(undefined as any);
    vi.mocked(CloudflarePages.addCustomDomain).mockResolvedValueOnce(undefined as any);

    const { deployTemplatePage } = await import('../deployment.service.js');

    const dbMock = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (/FROM apps WHERE id/i.test(sql)) {
          return Promise.resolve({
            rows: [{ deployment_backend: 'pages' }],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as import('pg').Pool;

    wireRuntimeDb(dbMock);
    const result = await deployTemplatePage(
      dbMock,
      'app_abc',
      'myapp',
      'My App',
      'user_1',
    );

    expect(result).toBe('bb-my-app');
    expect(CloudflarePages.createDeployment).toHaveBeenCalled();
    expect(CloudflareWfp.writeSubdomainMapping).not.toHaveBeenCalled();
  });
});

describe('deleteAppCloudflareResources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('on WfP apps: deletes KV mapping and user worker, skips Pages cleanup', async () => {
    const { deleteAppCloudflareResources } = await import('../deployment.service.js');

    const dbMock = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (/FROM apps WHERE id/i.test(sql)) {
          return Promise.resolve({
            rows: [{ subdomain: 'myapp', deployment_backend: 'wfp' }],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as import('pg').Pool;

    wireRuntimeDb(dbMock);
    await deleteAppCloudflareResources(dbMock, 'app_abc');

    expect(CloudflareWfp.deleteSubdomainMapping).toHaveBeenCalledWith('myapp');
    expect(CloudflareWfp.deleteUserWorker).toHaveBeenCalledWith('app_abc');
    expect(CloudflareWfp.deleteDoWorker).toHaveBeenCalledWith('app_abc_do');
    expect(CloudflarePages.deleteProject).not.toHaveBeenCalled();
    expect(CloudflarePages.deleteDnsRecord).not.toHaveBeenCalled();
    expect(CloudflarePages.removeCustomDomain).not.toHaveBeenCalled();
  });

  it('on WfP apps: tolerates 404 from deleteDoWorker (no DOs were registered)', async () => {
    vi.mocked(CloudflareWfp.deleteDoWorker).mockRejectedValueOnce(
      new Error('CF API error (404) /workers/dispatch/namespaces/bb-frontends/scripts/app_abc_do: [10007] script not found')
    );

    const { deleteAppCloudflareResources } = await import('../deployment.service.js');

    const dbMock = {
      query: vi.fn().mockResolvedValue({
        rows: [{ subdomain: 'myapp', deployment_backend: 'wfp' }],
      }),
    } as unknown as import('pg').Pool;

    wireRuntimeDb(dbMock);
    await expect(
      deleteAppCloudflareResources(dbMock, 'app_abc'),
    ).resolves.toBeUndefined();

    expect(CloudflareWfp.deleteDoWorker).toHaveBeenCalledWith('app_abc_do');
  });

  it('tolerates a 404 from deleteUserWorker (script never deployed)', async () => {
    vi.mocked(CloudflareWfp.deleteUserWorker).mockRejectedValueOnce(
      new Error('CF API error (404) /workers/dispatch/namespaces/bb-frontends/scripts/app_abc: [10007] script not found')
    );

    const { deleteAppCloudflareResources } = await import('../deployment.service.js');

    const dbMock = {
      query: vi.fn().mockResolvedValue({
        rows: [{ subdomain: 'myapp', deployment_backend: 'wfp' }],
      }),
    } as unknown as import('pg').Pool;

    wireRuntimeDb(dbMock);
    await expect(
      deleteAppCloudflareResources(dbMock, 'app_abc'),
    ).resolves.toBeUndefined();

    expect(CloudflareWfp.deleteSubdomainMapping).toHaveBeenCalledWith('myapp');
  });

  it('on Pages apps: uses the existing Pages cleanup path', async () => {
    const { deleteAppCloudflareResources } = await import('../deployment.service.js');

    const dbMock = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (/FROM apps WHERE id/i.test(sql)) {
          return Promise.resolve({
            rows: [{ subdomain: 'myapp', deployment_backend: 'pages' }],
          });
        }
        if (/FROM app_deployments/i.test(sql)) {
          return Promise.resolve({
            rows: [{ cloudflare_project_name: 'bb-myapp' }],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as import('pg').Pool;

    wireRuntimeDb(dbMock);
    await deleteAppCloudflareResources(dbMock, 'app_abc');

    expect(CloudflarePages.deleteProject).toHaveBeenCalledWith('bb-myapp');
    expect(CloudflareWfp.deleteUserWorker).not.toHaveBeenCalled();
    expect(CloudflareWfp.deleteSubdomainMapping).not.toHaveBeenCalled();
  });
});
