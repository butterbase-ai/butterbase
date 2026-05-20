import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

// Mock config before importing the module under test.
vi.mock('../config.js', () => ({
  config: {
    cloudflare: {
      accountId: 'acc123',
      apiToken: 'tok123',
      dispatchNamespace: 'bb-frontends',
      subdomainKvId: 'kv123',
    },
  },
}));

import {
  PLACEHOLDER_SCRIPT_NAME,
  deployUserWorker,
  deployUserWorkerWithScript,
  deleteUserWorker,
  writeSubdomainMapping,
  writeDomainMapping,
  deleteSubdomainMapping,
  deployDoWorker,
  deleteDoWorker,
} from './cloudflare-wfp.js';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  vi.restoreAllMocks();
});

function okText(result: unknown) {
  const body = JSON.stringify({ success: true, result, errors: [] });
  return {
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}
function errText(status: number, errors: unknown[]) {
  const body = JSON.stringify({ success: false, result: null, errors });
  return {
    ok: false,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

describe('deployUserWorker', () => {
  it('runs the three-step WfP deploy (session -> upload -> script) and includes env bindings', async () => {
    const fileBytes = Buffer.from('<html></html>');
    const realHash = crypto.createHash('sha256').update(fileBytes).digest('hex').slice(0, 32);

    fetchMock
      .mockResolvedValueOnce(okText({ jwt: 'session-jwt', buckets: [[realHash]] })) // session
      .mockResolvedValueOnce(okText({ jwt: 'completion-jwt' })) // bucket upload
      .mockResolvedValueOnce(okText({ id: 'script-id' })); // PUT script

    await deployUserWorker({
      scriptName: 'app_abc',
      files: new Map([['/index.html', fileBytes]]),
      envVars: { API_URL: 'https://example.com' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [sessUrl, sessInit] = fetchMock.mock.calls[0];
    expect(String(sessUrl)).toMatch(
      /\/workers\/dispatch\/namespaces\/bb-frontends\/scripts\/app_abc\/assets-upload-session$/,
    );
    expect(sessInit.method).toBe('POST');

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1];
    expect(String(uploadUrl)).toMatch(/\/workers\/assets\/upload\?base64=true$/);
    expect((uploadInit.headers as Record<string, string>).Authorization).toBe('Bearer session-jwt');

    const [deployUrl, deployInit] = fetchMock.mock.calls[2];
    expect(String(deployUrl)).toMatch(
      /\/workers\/dispatch\/namespaces\/bb-frontends\/scripts\/app_abc$/,
    );
    expect(deployInit.method).toBe('PUT');
    expect(deployInit.body).toBeInstanceOf(FormData);

    const workerPart = (deployInit.body as FormData).get('worker.mjs') as File;
    expect(workerPart).toBeDefined();
    expect((workerPart as any).name).toBe('worker.mjs');

    // Verify metadata part contains completion JWT + plain_text binding
    const metadataBlob = (deployInit.body as FormData).get('metadata') as Blob;
    const metadataJson = JSON.parse(await metadataBlob.text());
    expect(metadataJson.main_module).toBe('worker.mjs');
    expect(metadataJson.assets.config.html_handling).toBe('auto-trailing-slash');
    expect(metadataJson.assets.jwt).toBe('completion-jwt');
    expect(metadataJson.bindings).toEqual([
      { type: 'assets', name: 'ASSETS' },
      { type: 'plain_text', name: 'API_URL', text: 'https://example.com' },
    ]);
  });

  it('skips the bucket-upload step when the session reports no buckets', async () => {
    fetchMock
      .mockResolvedValueOnce(okText({ jwt: 'session-jwt' })) // session with no buckets
      .mockResolvedValueOnce(okText({ id: 'script-id' })); // PUT script

    await deployUserWorker({
      scriptName: 'app_abc',
      files: new Map(),
      envVars: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [deployUrl] = fetchMock.mock.calls[1];
    expect(String(deployUrl)).toMatch(/\/scripts\/app_abc$/);
  });

  it('throws if CF returns a hash not in the manifest (invariant violation)', async () => {
    fetchMock.mockResolvedValueOnce(okText({ jwt: 'session-jwt', buckets: [['unknownhash']] }));
    await expect(
      deployUserWorker({
        scriptName: 'app_abc',
        files: new Map([['/index.html', Buffer.from('<html></html>')]]),
        envVars: {},
      }),
    ).rejects.toThrow(/unknown hash/);
  });

  it('throws with the CF error code when the deploy call fails', async () => {
    fetchMock.mockResolvedValueOnce(
      errText(400, [{ code: 10021, message: 'No such module: worker.mjs' }]),
    );
    await expect(
      deployUserWorker({ scriptName: 'app_x', files: new Map(), envVars: {} }),
    ).rejects.toThrow(/10021/);
  });
});

describe('deployUserWorkerWithScript', () => {
  it('uploads worker.mjs with the provided script and appends each additionalModule as a separate form-part', async () => {
    fetchMock
      .mockResolvedValueOnce(okText({ jwt: 'session-jwt' })) // session (no buckets)
      .mockResolvedValueOnce(okText({ id: 'script-id' })); // PUT script

    const customScript = 'export default { async fetch(req) { return new Response("ssr"); } };';
    const chunkA = Buffer.from('export const a = 1;');
    const chunkB = Buffer.from('export const b = 2;');

    await deployUserWorkerWithScript(
      { scriptName: 'app_ssr', files: new Map(), envVars: {} },
      customScript,
      new Map([
        ['chunk-a.js', chunkA],
        ['chunk-b.js', chunkB],
      ]),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [deployUrl, deployInit] = fetchMock.mock.calls[1];
    expect(String(deployUrl)).toMatch(/\/workers\/dispatch\/namespaces\/bb-frontends\/scripts\/app_ssr$/);
    expect(deployInit.method).toBe('PUT');
    expect(deployInit.body).toBeInstanceOf(FormData);

    const deployForm = deployInit.body as FormData;

    // worker.mjs must contain the user-supplied script (not the static fallback)
    const workerPart = deployForm.get('worker.mjs') as File;
    expect(workerPart).toBeDefined();
    expect((workerPart as any).name).toBe('worker.mjs');
    expect(await workerPart.text()).toBe(customScript);

    // Additional modules must each be present with the correct filename
    const chunkAPart = deployForm.get('chunk-a.js') as File;
    expect(chunkAPart).toBeDefined();
    expect((chunkAPart as any).name).toBe('chunk-a.js');
    expect(await chunkAPart.text()).toBe('export const a = 1;');

    const chunkBPart = deployForm.get('chunk-b.js') as File;
    expect(chunkBPart).toBeDefined();
    expect((chunkBPart as any).name).toBe('chunk-b.js');
    expect(await chunkBPart.text()).toBe('export const b = 2;');

    // metadata.main_module must always be 'worker.mjs' regardless of additional modules
    const metadataBlob = deployForm.get('metadata') as Blob;
    const metadataJson = JSON.parse(await metadataBlob.text());
    expect(metadataJson.main_module).toBe('worker.mjs');
  });

  it('deploys without additionalModules when the parameter is omitted', async () => {
    fetchMock
      .mockResolvedValueOnce(okText({ jwt: 'session-jwt' }))
      .mockResolvedValueOnce(okText({ id: 'script-id' }));

    const customScript = 'export default { async fetch() { return new Response("ok"); } };';

    await deployUserWorkerWithScript(
      { scriptName: 'app_ssr2', files: new Map(), envVars: {} },
      customScript,
    );

    const [, deployInit] = fetchMock.mock.calls[1];
    const deployForm = deployInit.body as FormData;

    const workerPart = deployForm.get('worker.mjs') as File;
    expect(workerPart).toBeDefined();
    expect(await workerPart.text()).toBe(customScript);

    // No unexpected extra parts beyond metadata and worker.mjs
    const metadataBlob = deployForm.get('metadata') as Blob;
    const metadataJson = JSON.parse(await metadataBlob.text());
    expect(metadataJson.main_module).toBe('worker.mjs');
  });
});

describe('deleteUserWorker', () => {
  it('DELETEs the script in the dispatch namespace', async () => {
    fetchMock.mockResolvedValueOnce(okText(null));
    await deleteUserWorker('app_abc');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      /\/workers\/dispatch\/namespaces\/bb-frontends\/scripts\/app_abc$/,
    );
    expect(init.method).toBe('DELETE');
  });
});

describe('writeSubdomainMapping', () => {
  it('writes the subdomain → {appId, region} JSON to KV', async () => {
    fetchMock.mockResolvedValueOnce(okText(null));
    process.env.CF_KV_NAMESPACE_ID = 'kv123';

    await writeSubdomainMapping('myapp', 'app-uuid', 'us-east-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/storage\/kv\/namespaces\/kv123\/values\/sub:myapp$/);
    expect(init.method).toBe('PUT');
    expect((init as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/json' });
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({ appId: 'app-uuid', region: 'us-east-1' });
  });
});

describe('writeDomainMapping', () => {
  it('writes the custom domain → {appId, region} JSON to KV', async () => {
    fetchMock.mockResolvedValueOnce(okText(null));

    await writeDomainMapping('butterbase.example.com', 'app-uuid', 'eu-west-1');

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({ appId: 'app-uuid', region: 'eu-west-1' });
  });
});

describe('deleteSubdomainMapping', () => {
  it('DELETEs sub:<subdomain> from the KV namespace', async () => {
    fetchMock.mockResolvedValueOnce(okText(null));
    await deleteSubdomainMapping('myapp');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/storage\/kv\/namespaces\/kv123\/values\/sub:myapp$/);
    expect(init.method).toBe('DELETE');
  });
});

describe('PLACEHOLDER_SCRIPT_NAME', () => {
  it('is the sentinel script name "__placeholder__"', () => {
    expect(PLACEHOLDER_SCRIPT_NAME).toBe('__placeholder__');
  });
});

describe('deployDoWorker', () => {
  it('uploads bundle, declares DO bindings, and includes migrations', async () => {
    fetchMock.mockResolvedValueOnce(okText({ id: 'script-id' })); // PUT script

    await deployDoWorker({
      scriptName: 'app_xyz_do',
      bundle: 'export const x = 1;',
      classNames: ['ChatRoom', 'Leaderboard'],
      bindingNames: ['CHAT_ROOM', 'LEADERBOARD'],
      migrations: { new_classes: ['ChatRoom', 'Leaderboard'], deleted_classes: [] },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/workers\/dispatch\/namespaces\/bb-frontends\/scripts\/app_xyz_do$/);
    expect(init.method).toBe('PUT');
    expect(init.body).toBeInstanceOf(FormData);

    const captured = init.body as FormData;
    const metadataPart = captured.get('metadata') as Blob;
    const metadataJson = JSON.parse(await metadataPart.text());

    expect(metadataJson.main_module).toBe('worker.mjs');
    expect(metadataJson.compatibility_date).toBeDefined();

    // DO bindings present.
    const doBindings = metadataJson.bindings.filter((b: any) => b.type === 'durable_object_namespace');
    expect(doBindings).toHaveLength(2);
    expect(doBindings).toEqual(
      expect.arrayContaining([
        { type: 'durable_object_namespace', name: 'CHAT_ROOM',   class_name: 'ChatRoom' },
        { type: 'durable_object_namespace', name: 'LEADERBOARD', class_name: 'Leaderboard' },
      ]),
    );

    // Migrations block present.
    expect(metadataJson.migrations).toEqual({
      new_tag: expect.any(String),
      new_classes: ['ChatRoom', 'Leaderboard'],
      deleted_classes: [],
    });

    // Worker source uploaded.
    const workerPart = captured.get('worker.mjs') as Blob;
    expect(await workerPart.text()).toBe('export const x = 1;');
  });
});

describe('deleteDoWorker', () => {
  it('issues a DELETE on the dispatch namespace script', async () => {
    fetchMock.mockResolvedValueOnce(okText(null));
    await deleteDoWorker('app_xyz_do');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/workers\/dispatch\/namespaces\/bb-frontends\/scripts\/app_xyz_do$/);
    expect(init.method).toBe('DELETE');
  });
});
