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
  registerContainer, listContainers, deleteContainer, ContainerError,
} from './containers.service.js';

function mockPool(rowsByCall: Array<{ rows: any[] }>) {
  const q = vi.fn();
  rowsByCall.forEach((r) => q.mockResolvedValueOnce(r));
  q.mockResolvedValue({ rows: [] });
  return { query: q } as any;
}

beforeEach(() => vi.clearAllMocks());

describe('registerContainer', () => {
  const input = { name: 'game-server', image_digest: 'sha256:abc', mode: 'actor' as const, access_mode: 'public' as const };

  it('rejects invalid names', async () => {
    const db = mockPool([]);
    await expect(registerContainer(db, db, 'app_x', 'user_1', { ...input, name: 'Bad_Name' }))
      .rejects.toMatchObject({ code: 'INVALID_NAME' });
  });

  it('resolves image, upserts row DEPLOYING, deploys, marks READY', async () => {
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
});

describe('listContainers', () => {
  it('returns non-deleted rows', async () => {
    const runtimeDb = mockPool([{ rows: [{ id: 'ctr-1', name: 'game-server', status: 'READY' }] }]);
    const rows = await listContainers(runtimeDb, 'app_x');
    expect(rows).toHaveLength(1);
    expect(runtimeDb.query.mock.calls[0][0]).toContain('deleted_at IS NULL');
  });
});
