import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';

// AUTH_ENCRYPTION_KEY must be set so env-var decrypt resolves symmetrically.
process.env.AUTH_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

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
      defaultBackend: 'wfp',
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

vi.mock('../r2.js', () => ({
  generatePresignedUploadUrl: vi.fn(),
  downloadObjectAsBuffer: vi.fn(),
  deleteObject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../cloudflare-wfp.js', () => ({
  PLACEHOLDER_SCRIPT_NAME: '__placeholder__',
  deployUserWorkerWithScript: vi.fn().mockResolvedValue(undefined),
  writeSubdomainMapping: vi.fn().mockResolvedValue(undefined),
  deleteUserWorker: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../failure-notifications.service.js', () => ({
  notifyDeploymentFailed: vi.fn(() => Promise.resolve()),
}));

// runEdgeSsrPipeline resolves the per-app runtime pool via region-resolver.
// Return the supplied db so the existing mock-db assertions keep working.
vi.mock('../region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(async (db: unknown) => db),
  resolveAppHomeRegion: vi.fn(async () => 'local'),
}));

import * as R2 from '../r2.js';
import * as CloudflareWfp from '../cloudflare-wfp.js';
import * as FailureNotifs from '../failure-notifications.service.js';
import * as RuntimeDb from '../runtime-db.js';
import { runEdgeSsrPipeline } from '../edge-ssr-deployment.service.js';

function makeZipBuffer(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.from(content));
  }
  return zip.toBuffer();
}

interface QueryCall {
  sql: string;
  params?: unknown[];
}

interface MockDb {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  /** Recorded queries from BOTH the pool and any acquired client. */
  allQueries: QueryCall[];
}

/**
 * Build a mock that satisfies both the pg.Pool surface (`.query`, `.connect`)
 * and PoolClient surface (`.query`, `.release`). The `appRow`, `envVarRows`,
 * and optional `existingStaticDeploys` callback drive what the SELECT queries
 * return; everything else (UPDATE/INSERT/BEGIN/COMMIT) returns empty rows.
 */
function makeDb(args: {
  appRow: Record<string, unknown>;
  envVarRows?: Array<{ key: string; encrypted_value: string }>;
}): MockDb {
  const { appRow, envVarRows = [] } = args;
  const allQueries: QueryCall[] = [];

  const handle = async (sql: string, params?: unknown[]) => {
    allQueries.push({ sql, params });
    const normalized = sql.replace(/\s+/g, ' ').toLowerCase();
    if (normalized.includes('from apps') && normalized.includes('where id')) {
      return { rows: [appRow] };
    }
    if (normalized.includes('from app_frontend_env_vars')) {
      return { rows: envVarRows };
    }
    // deployArtifact() rediscovers app_id by scanning each runtime region for
    // a matching deployment row. All tests use app_abc (or app_cancel).
    if (normalized.includes('select app_id from app_edge_ssr_deployments')) {
      return { rows: [{ app_id: (appRow as { id?: string }).id ?? 'app_abc' }] };
    }
    return { rows: [] };
  };

  const client = {
    query: vi.fn(handle),
    release: vi.fn(),
  };

  return {
    query: vi.fn(handle),
    connect: vi.fn(async () => client),
    allQueries,
  };
}

// Phase 2: wire getRuntimeDbPool to return the same mock db that tests pass as
// the `db` argument, preserving assertions on db.query.mock.calls.
function wireRuntimeDb(mockDb: unknown): void {
  (RuntimeDb.getRuntimeDbPool as ReturnType<typeof vi.fn>).mockReturnValue(mockDb);
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks resets vi.fn implementations to no-op (returning undefined),
  // which breaks the `.catch()` call on notifyDeploymentFailed and the default
  // resolved values for the WfP mocks. Re-establish the implementations here.
  (FailureNotifs.notifyDeploymentFailed as ReturnType<typeof vi.fn>).mockImplementation(
    () => Promise.resolve()
  );
  (CloudflareWfp.deployUserWorkerWithScript as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (CloudflareWfp.writeSubdomainMapping as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (CloudflareWfp.deleteUserWorker as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (R2.deleteObject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('runEdgeSsrPipeline — _worker.js detection', () => {
  it('handles single-file _worker.js layout (deploys worker + 2 static assets)', async () => {
    const workerSrc = "export default { fetch() { return new Response('hi'); } };";
    const zipBuffer = makeZipBuffer({
      '_worker.js': workerSrc,
      'index.html': '<html>root</html>',
      'assets/app.css': 'body{}',
    });
    (R2.downloadObjectAsBuffer as ReturnType<typeof vi.fn>).mockResolvedValue(zipBuffer);

    const db = makeDb({
      appRow: { name: 'My App', subdomain: 'myapp', deployment_backend: 'wfp', region: 'local' },
    });

    wireRuntimeDb(db);
    await runEdgeSsrPipeline(
      db as unknown as import('pg').Pool,
      'app_abc',
      'edge_dep_1',
      { r2_object_key: 'r2/key', framework: 'other-edge' }
    );

    // deployUserWorkerWithScript called exactly once with correct shape
    expect(CloudflareWfp.deployUserWorkerWithScript).toHaveBeenCalledTimes(1);
    const args = (CloudflareWfp.deployUserWorkerWithScript as ReturnType<typeof vi.fn>).mock.calls[0];
    const [input, scriptStr, additionalModules, compatFlags, htmlHandling] = args;
    expect(input.scriptName).toBe('app_abc');
    expect(input.files).toBeInstanceOf(Map);
    expect(input.files.size).toBe(2);
    expect(input.files.has('/index.html')).toBe(true);
    expect(input.files.has('/assets/app.css')).toBe(true);
    expect(scriptStr).toBe(workerSrc);
    expect(additionalModules).toBeInstanceOf(Map);
    expect(additionalModules.size).toBe(0);
    // Edge SSR needs nodejs_compat + auto-trailing-slash so env.ASSETS.fetch('/')
    // resolves to /index.html for prerendered pages (next-on-pages has no
    // resolution chain of its own, unlike the static-frontend-worker).
    expect(compatFlags).toEqual(['nodejs_compat']);
    expect(htmlHandling).toBe('auto-trailing-slash');

    expect(CloudflareWfp.writeSubdomainMapping).toHaveBeenCalledWith('myapp', 'app_abc', 'local');

    // DB row reaches READY with deployment_url
    const readyUpdate = db.allQueries.find(
      (q) =>
        /update app_edge_ssr_deployments/i.test(q.sql) &&
        /deployment_url/i.test(q.sql) &&
        Array.isArray(q.params) &&
        (q.params as unknown[]).includes('https://myapp.butterbase.dev')
    );
    expect(readyUpdate).toBeDefined();
    expect(readyUpdate!.params).toContain('https://myapp.butterbase.dev');

    // R2 cleanup ran
    expect(R2.deleteObject).toHaveBeenCalledWith('r2/key');
  });

  it('handles _worker.js/ directory with chunked modules', async () => {
    const indexSrc = "import { handle } from './chunks/abc.js'; export default { fetch: handle };";
    const chunkSrc = "export function handle() { return new Response('chunked'); }";
    const zipBuffer = makeZipBuffer({
      '_worker.js/index.js': indexSrc,
      '_worker.js/chunks/abc.js': chunkSrc,
      'static/logo.svg': '<svg/>',
    });
    (R2.downloadObjectAsBuffer as ReturnType<typeof vi.fn>).mockResolvedValue(zipBuffer);

    const db = makeDb({
      appRow: { name: 'My App', subdomain: 'myapp', deployment_backend: 'wfp', region: 'local' },
    });

    wireRuntimeDb(db);
    await runEdgeSsrPipeline(
      db as unknown as import('pg').Pool,
      'app_abc',
      'edge_dep_2',
      { r2_object_key: 'r2/key', framework: 'nextjs-edge' }
    );

    expect(CloudflareWfp.deployUserWorkerWithScript).toHaveBeenCalledTimes(1);
    const [input, scriptStr, additionalModules] =
      (CloudflareWfp.deployUserWorkerWithScript as ReturnType<typeof vi.fn>).mock.calls[0];

    // Entry script is index.js content
    expect(scriptStr).toBe(indexSrc);

    // additionalModules contains exactly 1 entry, keyed RELATIVE to _worker.js/
    expect(additionalModules).toBeInstanceOf(Map);
    expect(additionalModules.size).toBe(1);
    expect(additionalModules.has('chunks/abc.js')).toBe(true);
    // Must NOT include the _worker.js/ prefix (Cloudflare resolves imports by form-part filename)
    expect(additionalModules.has('_worker.js/chunks/abc.js')).toBe(false);
    expect((additionalModules.get('chunks/abc.js') as Buffer).toString('utf-8')).toBe(chunkSrc);

    // Static assets: only the non-_worker.js/ file
    expect(input.files.size).toBe(1);
    expect(input.files.has('/static/logo.svg')).toBe(true);
  });

  it('filters _worker.js/ non-module files — .map and .json are silently dropped, not deployed or in static assets', async () => {
    const indexSrc = "export default { fetch() { return new Response('ok'); } };";
    const chunkSrc = "export const x = 1;";
    const zipBuffer = makeZipBuffer({
      '_worker.js/index.js': indexSrc,
      '_worker.js/chunks/abc.js': chunkSrc,
      '_worker.js/index.js.map': '{"version":3}',
      '_worker.js/_routes.json': '{"version":1,"include":["/*"],"exclude":[]}',
    });
    (R2.downloadObjectAsBuffer as ReturnType<typeof vi.fn>).mockResolvedValue(zipBuffer);

    const db = makeDb({
      appRow: { name: 'My App', subdomain: 'myapp', deployment_backend: 'wfp', region: 'local' },
    });

    wireRuntimeDb(db);
    await runEdgeSsrPipeline(
      db as unknown as import('pg').Pool,
      'app_abc',
      'edge_dep_filter',
      { r2_object_key: 'r2/key', framework: 'nextjs-edge' }
    );

    expect(CloudflareWfp.deployUserWorkerWithScript).toHaveBeenCalledTimes(1);
    const [input, _scriptStr, additionalModules] =
      (CloudflareWfp.deployUserWorkerWithScript as ReturnType<typeof vi.fn>).mock.calls[0];

    // Only the .js chunk should be in additionalModules — .map and .json are dropped
    expect(additionalModules).toBeInstanceOf(Map);
    expect(additionalModules.size).toBe(1);
    expect(additionalModules.has('chunks/abc.js')).toBe(true);
    expect(additionalModules.has('index.js.map')).toBe(false);
    expect(additionalModules.has('_routes.json')).toBe(false);

    // Dropped files must not appear in static assets either
    expect(input.files).toBeInstanceOf(Map);
    expect(input.files.has('/index.js.map')).toBe(false);
    expect(input.files.has('/_routes.json')).toBe(false);
    // No static assets at all (all files were under _worker.js/)
    expect(input.files.size).toBe(0);
  });

  it('rejects zip missing _worker.js — DB row goes to ERROR with MISSING_WORKER_JS message', async () => {
    const zipBuffer = makeZipBuffer({
      'index.html': '<html/>',
      'app.js': 'console.log(1)',
    });
    (R2.downloadObjectAsBuffer as ReturnType<typeof vi.fn>).mockResolvedValue(zipBuffer);

    const db = makeDb({
      appRow: { name: 'My App', subdomain: 'myapp', deployment_backend: 'wfp', region: 'local' },
    });

    wireRuntimeDb(db);
    await runEdgeSsrPipeline(
      db as unknown as import('pg').Pool,
      'app_abc',
      'edge_dep_3',
      { r2_object_key: 'r2/key', framework: 'other-edge' }
    );

    // Must NOT have called the deploy
    expect(CloudflareWfp.deployUserWorkerWithScript).not.toHaveBeenCalled();
    expect(CloudflareWfp.writeSubdomainMapping).not.toHaveBeenCalled();

    // DB ERROR update with the missing-worker message
    const errorUpdate = db.allQueries.find(
      (q) =>
        /update app_edge_ssr_deployments/i.test(q.sql) &&
        /status = 'error'/i.test(q.sql)
    );
    expect(errorUpdate).toBeDefined();
    const errMsg = (errorUpdate!.params as unknown[])[0] as string;
    expect(errMsg).toMatch(/_worker\.js/);

    expect(FailureNotifs.notifyDeploymentFailed).toHaveBeenCalledTimes(1);
  });
});

describe('runEdgeSsrPipeline — cancel-race guard', () => {
  it('skips supersede and READY transition when row is CANCELED before commitReadyAndSupersede runs', async () => {
    const workerSrc = "export default { fetch() { return new Response('hi'); } };";
    const zipBuffer = makeZipBuffer({
      '_worker.js': workerSrc,
      'index.html': '<html/>',
    });
    (R2.downloadObjectAsBuffer as ReturnType<typeof vi.fn>).mockResolvedValue(zipBuffer);

    const allQueries: Array<{ sql: string; params?: unknown[] }> = [];

    // Build a db where the PoolClient's FOR UPDATE SELECT returns CANCELED,
    // simulating a cancel that raced with the WfP push.
    const canceledClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        allQueries.push({ sql, params });
        const normalized = sql.replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes('for update') && normalized.includes('app_edge_ssr_deployments')) {
          // Simulate: someone called cancelDeployment while WfP was pushing
          return { rows: [{ status: 'CANCELED' }] };
        }
        // BEGIN / COMMIT / other queries return empty
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        allQueries.push({ sql, params });
        const normalized = sql.replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes('from apps') && normalized.includes('where id')) {
          return { rows: [{ name: 'My App', subdomain: 'myapp', deployment_backend: 'wfp', region: 'local' }] };
        }
        if (normalized.includes('from app_frontend_env_vars')) {
          return { rows: [] };
        }
        if (normalized.includes('select app_id from app_edge_ssr_deployments')) {
          return { rows: [{ app_id: 'app_cancel' }] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(async () => canceledClient),
    };

    wireRuntimeDb(db);
    await runEdgeSsrPipeline(
      db as unknown as import('pg').Pool,
      'app_cancel',
      'edge_dep_cancel',
      { r2_object_key: 'r2/key', framework: 'nextjs-edge' }
    );

    // The supersede UPDATEs must NOT have run
    const supersededUpdate = allQueries.find(
      (q) =>
        /update app_deployments/i.test(q.sql) &&
        /status = 'superseded'/i.test(q.sql)
    );
    expect(supersededUpdate).toBeUndefined();

    const ssrSupersedeUpdate = allQueries.find(
      (q) =>
        /update app_edge_ssr_deployments/i.test(q.sql) &&
        /status = 'superseded'/i.test(q.sql)
    );
    expect(ssrSupersedeUpdate).toBeUndefined();

    // The READY UPDATE must NOT have run
    const readyUpdate = allQueries.find(
      (q) =>
        /update app_edge_ssr_deployments/i.test(q.sql) &&
        /deployment_url/i.test(q.sql)
    );
    expect(readyUpdate).toBeUndefined();

    // COMMIT was still called (no-op transaction)
    const commitQuery = allQueries.find((q) => /^\s*commit/i.test(q.sql));
    expect(commitQuery).toBeDefined();
  });
});

describe('runEdgeSsrPipeline — supersede behavior', () => {
  it('marks active static app_deployments as SUPERSEDED when SSR deploy succeeds', async () => {
    const workerSrc = "export default { fetch() { return new Response('hi'); } };";
    const zipBuffer = makeZipBuffer({
      '_worker.js': workerSrc,
      'index.html': '<html/>',
    });
    (R2.downloadObjectAsBuffer as ReturnType<typeof vi.fn>).mockResolvedValue(zipBuffer);

    const db = makeDb({
      appRow: { name: 'My App', subdomain: 'myapp', deployment_backend: 'wfp', region: 'local' },
    });

    wireRuntimeDb(db);
    await runEdgeSsrPipeline(
      db as unknown as import('pg').Pool,
      'app_abc',
      'edge_dep_4',
      { r2_object_key: 'r2/key', framework: 'other-edge' }
    );

    // Find the supersede UPDATE on app_deployments — must be inside transaction (BEGIN seen first)
    const beginIdx = db.allQueries.findIndex((q) => /^\s*begin/i.test(q.sql));
    expect(beginIdx).toBeGreaterThanOrEqual(0);

    const supersedeIdx = db.allQueries.findIndex(
      (q, i) =>
        i > beginIdx &&
        /update app_deployments/i.test(q.sql) &&
        /status = 'superseded'/i.test(q.sql) &&
        /\bin \('waiting', 'uploading', 'building', 'ready'\)/i.test(q.sql)
    );
    expect(supersedeIdx).toBeGreaterThan(beginIdx);
    // The supersede UPDATE was scoped to this app
    expect((db.allQueries[supersedeIdx].params as unknown[])[0]).toBe('app_abc');

    // Sibling supersede on app_edge_ssr_deployments (excluding the current row) also fires
    const siblingSupersedeIdx = db.allQueries.findIndex(
      (q, i) =>
        i > beginIdx &&
        /update app_edge_ssr_deployments/i.test(q.sql) &&
        /status = 'superseded'/i.test(q.sql)
    );
    expect(siblingSupersedeIdx).toBeGreaterThan(beginIdx);
    expect((db.allQueries[siblingSupersedeIdx].params as unknown[])[0]).toBe('app_abc');
    expect((db.allQueries[siblingSupersedeIdx].params as unknown[])[1]).toBe('edge_dep_4');

    // COMMIT happened
    const commitIdx = db.allQueries.findIndex((q) => /^\s*commit/i.test(q.sql));
    expect(commitIdx).toBeGreaterThan(supersedeIdx);
  });
});
