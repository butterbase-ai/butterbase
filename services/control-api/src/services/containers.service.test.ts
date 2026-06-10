// services/control-api/src/services/containers.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./cloudflare-containers.js', () => ({
  deployContainerWorker: vi.fn().mockResolvedValue(undefined),
  deleteContainerWorker: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../config.js', () => ({
  config: { cloudflare: { accountId: 'acc123', containerRegistryHost: 'registry.cloudflare.com', containersDispatchNamespace: 'bb-containers' } },
}));
process.env.AUTH_ENCRYPTION_KEY = '0'.repeat(64);

import * as Cf from './cloudflare-containers.js';
import {
  registerContainer, listContainers, deleteContainer, setContainerEnvVar, ContainerError,
} from './containers.service.js';

function mockPool(rowsByCall: Array<{ rows: any[] }>) {
  const q = vi.fn();
  rowsByCall.forEach((r) => q.mockResolvedValueOnce(r));
  q.mockResolvedValue({ rows: [] });
  return { query: q } as any;
}

beforeEach(() => vi.clearAllMocks());

const input = { name: 'game-server', image_digest: 'sha256:abc', mode: 'actor' as const, access_mode: 'public' as const };

describe('registerContainer', () => {

  it('rejects invalid names', async () => {
    const db = mockPool([]);
    await expect(registerContainer(db, db, 'app_x', 'user_1', { ...input, name: 'Bad_Name' }))
      .rejects.toMatchObject({ code: 'INVALID_NAME' });
  });

  it('resolves image, upserts row DEPLOYING, deploys, marks READY (isFirstDeploy: true)', async () => {
    const controlDb = mockPool([
      { rows: [{ id: 'img-1', registry_repo: 'app_x/game-server', digest: 'sha256:abc' }] }, // image lookup
    ]);
    const runtimeDb = mockPool([
      { rows: [{ n: 0 }] },                     // quota count
      { rows: [{ id: 'ctr-1' }] },              // upsert RETURNING id
      { rows: [] },                             // env var load
      { rows: [{ exists: false }] },            // first-deploy check (no prior last_deployed_at)
      { rows: [] },                             // UPDATE → READY
    ]);
    const out = await registerContainer(runtimeDb, controlDb, 'app_x', 'user_1', input);
    expect(out.status).toBe('READY');
    expect(Cf.deployContainerWorker).toHaveBeenCalledWith(expect.objectContaining({
      scriptName: 'app_x_ctr_game-server',
      imageRef: expect.stringContaining('@sha256:abc'),
      isFirstDeploy: true,
    }));
  });

  it('sends isFirstDeploy: false when last_deployed_at is already set (redeploy)', async () => {
    const controlDb = mockPool([
      { rows: [{ id: 'img-1', registry_repo: 'app_x/game-server', digest: 'sha256:abc' }] },
    ]);
    const runtimeDb = mockPool([
      { rows: [{ n: 0 }] },                     // quota count
      { rows: [{ id: 'ctr-1' }] },              // upsert RETURNING id
      { rows: [] },                             // env var load
      { rows: [{ exists: true }] },             // last_deployed_at IS NOT NULL → redeploy
      { rows: [] },                             // UPDATE → READY
    ]);
    const out = await registerContainer(runtimeDb, controlDb, 'app_x', 'user_1', input);
    expect(out.status).toBe('READY');
    expect(Cf.deployContainerWorker).toHaveBeenCalledWith(expect.objectContaining({
      isFirstDeploy: false,
    }));
  });

  it('marks ERROR and rethrows when CF deploy fails', async () => {
    (Cf.deployContainerWorker as any).mockRejectedValueOnce(new Error('CF API error (502)'));
    const controlDb = mockPool([{ rows: [{ id: 'img-1', registry_repo: 'app_x/game-server', digest: 'sha256:abc' }] }]);
    const runtimeDb = mockPool([
      { rows: [{ n: 0 }] },                     // quota count
      { rows: [{ id: 'ctr-1' }] },              // upsert
      { rows: [] },                             // env var load
      { rows: [{ exists: false }] },            // first-deploy check
    ]);
    await expect(registerContainer(runtimeDb, controlDb, 'app_x', 'user_1', input))
      .rejects.toMatchObject({ code: 'CF_DEPLOY_FAILED' });
    const errUpdate = runtimeDb.query.mock.calls.find((c: any[]) => String(c[0]).includes("'ERROR'"));
    expect(errUpdate).toBeTruthy();
  });

  it('throws IMAGE_NOT_FOUND when digest is not in container_images', async () => {
    const controlDb = mockPool([{ rows: [] }]);
    const runtimeDb = mockPool([]);
    await expect(registerContainer(runtimeDb, controlDb, 'app_x', 'user_1', input))
      .rejects.toMatchObject({ code: 'IMAGE_NOT_FOUND' });
  });
});

describe('deleteContainer', () => {
  it('soft-deletes, deletes the script, decrements image ref', async () => {
    const runtimeDb = mockPool([
      { rows: [{ id: 'ctr-1', image_id: 'img-1' }] }, // lookup
      { rows: [] },                                    // soft delete
    ]);
    const controlDb = mockPool([{ rows: [] }]);        // ref decrement
    await deleteContainer(runtimeDb, controlDb, 'app_x', 'game-server');
    expect(Cf.deleteContainerWorker).toHaveBeenCalledWith('app_x_ctr_game-server');
    expect(controlDb.query.mock.calls[0][0]).toContain('GREATEST(ref_count - 1, 0)');
  });

  it('NOT_FOUND when the row does not exist', async () => {
    const runtimeDb = mockPool([{ rows: [] }]);
    await expect(deleteContainer(runtimeDb, mockPool([]), 'app_x', 'nope'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('register → delete → re-register sends isFirstDeploy: true on the second deploy', async () => {
    // ── First register ──
    const controlDb1 = mockPool([
      { rows: [{ id: 'img-1', registry_repo: 'app_x/game-server', digest: 'sha256:abc' }] },
    ]);
    const runtimeDb1 = mockPool([
      { rows: [{ n: 0 }] },          // quota count
      { rows: [{ id: 'ctr-1' }] },   // upsert RETURNING id
      { rows: [] },                  // env var load
      { rows: [{ exists: false }] }, // first-deploy check
      { rows: [] },                  // UPDATE → READY
    ]);
    await registerContainer(runtimeDb1, controlDb1, 'app_x', 'user_1', input);
    const firstCall = (Cf.deployContainerWorker as any).mock.calls[0][0];
    expect(firstCall.isFirstDeploy).toBe(true);

    vi.clearAllMocks();

    // ── Delete ──
    const runtimeDb2 = mockPool([
      { rows: [{ id: 'ctr-1', image_id: 'img-1' }] }, // lookup
      { rows: [] },                                    // soft-delete (last_deployed_at = NULL)
    ]);
    const controlDb2 = mockPool([{ rows: [] }]);       // ref decrement
    await deleteContainer(runtimeDb2, controlDb2, 'app_x', 'game-server');

    vi.clearAllMocks();

    // ── Re-register: deleteContainer reset last_deployed_at, so exists = false ──
    const controlDb3 = mockPool([
      { rows: [{ id: 'img-1', registry_repo: 'app_x/game-server', digest: 'sha256:abc' }] },
    ]);
    const runtimeDb3 = mockPool([
      { rows: [{ n: 0 }] },          // quota count (existing deleted row excluded by name <> $2)
      { rows: [{ id: 'ctr-1' }] },   // upsert RETURNING id (conflict on app_id,name, clears deleted_at)
      { rows: [] },                  // env var load
      { rows: [{ exists: false }] }, // last_deployed_at was NULLed by delete → first deploy again
      { rows: [] },                  // UPDATE → READY
    ]);
    const out = await registerContainer(runtimeDb3, controlDb3, 'app_x', 'user_1', input);
    expect(out.status).toBe('READY');
    const secondCall = (Cf.deployContainerWorker as any).mock.calls[0][0];
    expect(secondCall.isFirstDeploy).toBe(true);
  });
});

describe('listContainers', () => {
  it('returns non-deleted rows', async () => {
    const runtimeDb = mockPool([{ rows: [{ id: 'ctr-1', name: 'game-server', status: 'READY' }] }]);
    const rows = await listContainers(runtimeDb, 'app_x');
    expect(rows).toHaveLength(1);
    expect(runtimeDb.query.mock.calls[0][0]).toContain('deleted_at IS NULL');
  });
});

describe('setContainerEnvVar', () => {
  const baseRow = {
    id: 'ctr-1', name: 'game-server', image_id: 'img-1',
    mode: 'pool', access_mode: 'service_key', port: 8080,
    sleep_after_s: 300, max_instances: 5, instance_type: 'basic',
    status: 'READY', deleted_at: null,
  };

  it('rejects key CTR with ENV_BINDING_COLLISION before any DB write', async () => {
    const runtimeDb = mockPool([]);
    await expect(
      setContainerEnvVar(runtimeDb, mockPool([]), 'app_x', 'game-server', 'CTR', 'val'),
    ).rejects.toMatchObject({ code: 'ENV_BINDING_COLLISION' });
    expect(runtimeDb.query).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when container does not exist', async () => {
    const runtimeDb = mockPool([
      { rows: [] }, // getContainer lookup → empty
    ]);
    await expect(
      setContainerEnvVar(runtimeDb, mockPool([]), 'app_x', 'missing', 'FOO', 'bar'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('happy path: returns {redeployed:true} and calls deployContainerWorker with isFirstDeploy:false when READY', async () => {
    // setContainerEnvVar calls getContainer (1 runtimeDb query), upserts env var (1), then
    // redeployFromRow which calls getContainer again (1) + env load (1).
    // redeployFromRow also does a controlDb image lookup.
    const runtimeDb = mockPool([
      { rows: [baseRow] },                             // getContainer for setContainerEnvVar
      { rows: [] },                                    // upsert env var
      { rows: [baseRow] },                             // getContainer inside redeployFromRow
      { rows: [] },                                    // loadEnvVars inside redeployFromRow
    ]);
    const controlDb = mockPool([
      { rows: [{ registry_repo: 'app_x/game-server', digest: 'sha256:abc' }] }, // image lookup
    ]);
    const result = await setContainerEnvVar(runtimeDb, controlDb, 'app_x', 'game-server', 'FOO', 'bar');
    expect(result).toEqual({ redeployed: true });
    expect(Cf.deployContainerWorker).toHaveBeenCalledWith(expect.objectContaining({
      isFirstDeploy: false,
    }));
  });

  it('returns {redeployed:false} when container status is DEPLOYING', async () => {
    const deployingRow = { ...baseRow, status: 'DEPLOYING' };
    const runtimeDb = mockPool([
      { rows: [deployingRow] }, // getContainer for setContainerEnvVar
      { rows: [] },             // upsert env var
      { rows: [deployingRow] }, // getContainer inside redeployFromRow → status !== READY → bail
    ]);
    const result = await setContainerEnvVar(runtimeDb, mockPool([]), 'app_x', 'game-server', 'FOO', 'bar');
    expect(result).toEqual({ redeployed: false });
    expect(Cf.deployContainerWorker).not.toHaveBeenCalled();
  });
});
