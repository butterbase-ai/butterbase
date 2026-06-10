import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    cloudflare: {
      accountId: 'acc123',
      apiToken: 'tok123',
      containersDispatchNamespace: 'bb-containers',
      containerRegistryHost: 'registry.cloudflare.com',
    },
  },
}));

import { deployContainerWorker, deleteContainerWorker } from './cloudflare-containers.js';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockResolvedValue({
    ok: true, status: 200,
    text: async () => JSON.stringify({ success: true, result: {}, errors: [] }),
    json: async () => ({ success: true, result: {}, errors: [] }),
  });
});
afterEach(() => vi.restoreAllMocks());

describe('deployContainerWorker', () => {
  it('PUTs to bb-containers with container + DO bindings and env vars', async () => {
    await deployContainerWorker({
      scriptName: 'app_abc_ctr_game-server',
      workerSource: '// worker',
      imageRef: 'registry.cloudflare.com/acc123/app_abc/game-server@sha256:deadbeef',
      instanceType: 'basic',
      maxInstances: 5,
      envVars: { FOO: 'bar' },
      isFirstDeploy: true,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/workers/dispatch/namespaces/bb-containers/scripts/app_abc_ctr_game-server');
    expect(init.method).toBe('PUT');
    const form = init.body as FormData;
    const meta = JSON.parse(await (form.get('metadata') as Blob).text());
    expect(meta.containers[0]).toMatchObject({
      class_name: 'CtrFrontDoor',
      image: 'registry.cloudflare.com/acc123/app_abc/game-server@sha256:deadbeef',
      instance_type: 'basic',
      max_instances: 5,
    });
    expect(meta.bindings).toContainEqual({ type: 'durable_object_namespace', name: 'CTR', class_name: 'CtrFrontDoor' });
    expect(meta.bindings).toContainEqual({ type: 'plain_text', name: 'FOO', text: 'bar' });
    expect(meta.migrations).toMatchObject({ new_tag: 'v1', new_sqlite_classes: ['CtrFrontDoor'] });
    expect(meta.main_module).toBe('worker.mjs');
    // worker module part present with the right filename
    expect(form.get('worker.mjs')).toBeTruthy();
  });

  it('omits migrations on redeploy (isFirstDeploy=false)', async () => {
    await deployContainerWorker({
      scriptName: 's', workerSource: '//', imageRef: 'r@sha256:x',
      instanceType: 'dev', maxInstances: 1, envVars: {}, isFirstDeploy: false,
    });
    const meta = JSON.parse(await ((fetchMock.mock.calls[0]![1].body as FormData).get('metadata') as Blob).text());
    expect(meta.migrations).toBeUndefined();
  });
});

describe('deleteContainerWorker', () => {
  it('DELETEs the script', async () => {
    await deleteContainerWorker('app_abc_ctr_game-server');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/scripts/app_abc_ctr_game-server');
    expect(init.method).toBe('DELETE');
  });
});
