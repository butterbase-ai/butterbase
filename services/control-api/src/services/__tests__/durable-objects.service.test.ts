import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../cloudflare-wfp.js', () => ({
  deployDoWorker: vi.fn().mockResolvedValue({ newTag: 'v-test' }),
  deleteDoWorker: vi.fn().mockResolvedValue(undefined),
  getDoWorkerMigrationTag: vi.fn().mockResolvedValue(null),
}));

import * as DurableObjectsService from '../durable-objects.service.js';
import * as CloudflareWfp from '../cloudflare-wfp.js';

function makeMockDb() {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const queryResults: any[] = [];
  const handle = async (text: string, values: unknown[] = []) => {
    queries.push({ text, values });
    return queryResults.shift() ?? { rows: [] };
  };
  return {
    queries,
    queryResults,
    db: {
      query: vi.fn(handle),
      connect: vi.fn(async () => ({
        query: vi.fn(handle),
        release: vi.fn(),
      })),
    } as any,
  };
}

describe('registerDurableObject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (CloudflareWfp.deployDoWorker as any).mockResolvedValue({ newTag: 'v-test' });
    (CloudflareWfp.deleteDoWorker as any).mockResolvedValue(undefined);
    ((CloudflareWfp as any).getDoWorkerMigrationTag as any).mockResolvedValue(null);
  });

  it('inserts a new class, bundles + deploys with new_classes migration, updates state', async () => {
    const m = makeMockDb();
    // Sequence of expected queries:
    //  1. INSERT INTO app_durable_objects ... RETURNING id          -> row { id: 'do_1' }
    //  2. SELECT * FROM app_durable_objects WHERE app_id = $1       -> all current classes
    //  3. SELECT deployed_class_names FROM app_do_deploy_state ...  -> previous
    //  4. INSERT INTO app_do_deploy_state ... ON CONFLICT DO UPDATE ->
    //  5. UPDATE app_durable_objects ... SET status='READY'         ->
    m.queryResults.push(
      { rows: [{ id: 'do_1' }] },
      { rows: [{ id: 'do_1', name: 'chat-room', class_name: 'ChatRoom', code: 'export class ChatRoom {}', access_mode: 'public' }] },
      { rows: [] }, // No prior deploy state.
      { rows: [] }, // No DO env vars.
      { rows: [] },
      { rows: [] },
    );

    const result = await DurableObjectsService.registerDurableObject(m.db, 'app_xyz', 'user_1', {
      name: 'chat-room',
      code: 'export class ChatRoom {}',
      access_mode: 'public',
    });

    expect(result).toMatchObject({ id: 'do_1', name: 'chat-room', status: 'READY' });

    expect(CloudflareWfp.deployDoWorker).toHaveBeenCalledTimes(1);
    const wfpCall = (CloudflareWfp.deployDoWorker as any).mock.calls[0][0];
    expect(wfpCall.scriptName).toBe('app_xyz_do');
    expect(wfpCall.classNames).toEqual(['ChatRoom']);
    expect(wfpCall.migrations).toEqual({ new_classes: ['ChatRoom'], deleted_classes: [] });

    // Last deploy_state UPSERT carries the new class names.
    const upsertQuery = m.queries.find((q) => q.text.includes('app_do_deploy_state') && q.text.includes('INSERT'))!;
    expect(upsertQuery.values).toEqual(
      expect.arrayContaining(['app_xyz', expect.arrayContaining(['ChatRoom'])]),
    );

    // BUILDING was set before deploy.
    const buildingUpdate = m.queries.find((q) => q.text.includes("status = 'BUILDING'"));
    expect(buildingUpdate).toBeDefined();
    // READY was set after deploy.
    const readyUpdate = m.queries.find((q) => q.text.includes("status = 'READY'"));
    expect(readyUpdate).toBeDefined();
  });

  it('marks row ERROR with error_message when deploy fails', async () => {
    const m = makeMockDb();
    (CloudflareWfp.deployDoWorker as any).mockRejectedValueOnce(new Error('cf 500'));
    m.queryResults.push(
      { rows: [{ id: 'do_1' }] }, // INSERT (BUILDING)
      { rows: [{ id: 'do_1', name: 'chat-room', class_name: 'ChatRoom', code: 'export class ChatRoom {}', access_mode: 'public' }] }, // SELECT active
      { rows: [] },                // SELECT prev state
      { rows: [] },                // SELECT do env vars
      // deployDoWorker rejects -> no persistDeployState -> UPDATE ERROR
      { rows: [] },                // UPDATE ERROR
    );

    await expect(
      DurableObjectsService.registerDurableObject(m.db, 'app_xyz', 'user_1', {
        name: 'chat-room',
        code: 'export class ChatRoom {}',
        access_mode: 'public',
      }),
    ).rejects.toThrow();

    // ERROR status was written with the error message.
    const errorUpdate = m.queries.find((q) => q.text.includes("status = 'ERROR'") && q.text.includes('error_message'));
    expect(errorUpdate).toBeDefined();
    // wrapCfDeployError prepends "Failed to deploy Durable Object Worker to Cloudflare:"
    // before the raw CF message; assert on substring rather than exact match.
    const wrappedMessage = errorUpdate!.values.find(
      (v): v is string => typeof v === 'string' && v.includes('cf 500'),
    );
    expect(wrappedMessage).toBeDefined();
  });

  it('rejects invalid name with INVALID_NAME and no DB writes', async () => {
    const m = makeMockDb();
    await expect(
      DurableObjectsService.registerDurableObject(m.db, 'app_xyz', 'user_1', {
        name: 'Bad Name',  // space — invalid
        code: 'export class X {}',
        access_mode: 'public',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_NAME' });
    expect(m.queries.length).toBe(0);
    expect(CloudflareWfp.deployDoWorker).not.toHaveBeenCalled();
  });

  it('rejects extractClassName failure (no class) with NO_EXPORTED_CLASS, no DB writes', async () => {
    const m = makeMockDb();
    await expect(
      DurableObjectsService.registerDurableObject(m.db, 'app_xyz', 'user_1', {
        name: 'bad',
        code: 'export const foo = 1;',  // no class
        access_mode: 'public',
      }),
    ).rejects.toMatchObject({ code: 'NO_EXPORTED_CLASS' });
    expect(m.queries.length).toBe(0);
  });

  it('updating an existing class produces empty new_classes and deleted_classes diff', async () => {
    const m = makeMockDb();
    m.queryResults.push(
      { rows: [{ id: 'do_1' }] },                                       // INSERT ON CONFLICT returning id
      { rows: [{ id: 'do_1', name: 'chat-room', class_name: 'ChatRoom', code: 'export class ChatRoom {}', access_mode: 'public' }] },  // loadActive
      { rows: [{ deployed_class_names: ['ChatRoom'] }] },               // prev state
      { rows: [] },                                                     // SELECT do env vars
      { rows: [] },                                                     // persist deploy state UPSERT
      { rows: [] },                                                     // status -> READY
    );

    await DurableObjectsService.registerDurableObject(m.db, 'app_xyz', 'user_1', {
      name: 'chat-room',
      code: 'export class ChatRoom {}',
      access_mode: 'public',
    });

    const wfpCall = (CloudflareWfp.deployDoWorker as any).mock.calls[0][0];
    expect(wfpCall.migrations).toEqual({ new_classes: [], deleted_classes: [] });
  });
});

describe('deleteDurableObject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (CloudflareWfp.deployDoWorker as any).mockResolvedValue({ newTag: 'v-test' });
    (CloudflareWfp.deleteDoWorker as any).mockResolvedValue(undefined);
    ((CloudflareWfp as any).getDoWorkerMigrationTag as any).mockResolvedValue(null);
  });

  it('redeploys without the class and uses deleted_classes migration', async () => {
    const m = makeMockDb();
    m.queryResults.push(
      { rows: [{ id: 'do_1', class_name: 'ChatRoom' }] }, // SELECT existing row
      { rows: [] }, // DELETE row
      { rows: [{ id: 'do_2', name: 'leaderboard', class_name: 'Leaderboard', code: 'export class Leaderboard {}', access_mode: 'authenticated' }] }, // remaining classes (loadActiveClasses inside bundleAndDeploy)
      { rows: [{ deployed_class_names: ['ChatRoom', 'Leaderboard'] }] }, // prev state
      { rows: [] }, // SELECT do env vars
      { rows: [] }, // UPSERT deploy_state
    );

    await DurableObjectsService.deleteDurableObject(m.db, 'app_xyz', 'chat-room');

    expect(CloudflareWfp.deployDoWorker).toHaveBeenCalledTimes(1);
    const call = (CloudflareWfp.deployDoWorker as any).mock.calls[0][0];
    expect(call.classNames).toEqual(['Leaderboard']);
    expect(call.migrations).toEqual({ new_classes: [], deleted_classes: ['ChatRoom'] });
    expect(CloudflareWfp.deleteDoWorker).not.toHaveBeenCalled();
  });

  it('deletes the entire WfP script when no classes remain', async () => {
    const m = makeMockDb();
    m.queryResults.push(
      { rows: [{ id: 'do_1', class_name: 'ChatRoom' }] }, // SELECT existing
      { rows: [] },                                       // DELETE row
      { rows: [] },                                       // SELECT active (none left)
      { rows: [] },                                       // UPSERT empty deploy_state
    );

    await DurableObjectsService.deleteDurableObject(m.db, 'app_xyz', 'chat-room');

    expect(CloudflareWfp.deployDoWorker).not.toHaveBeenCalled();
    expect(CloudflareWfp.deleteDoWorker).toHaveBeenCalledWith('app_xyz_do');

    // persistDeployState called with empty classNames array.
    const upsert = m.queries.find((q) => q.text.includes('app_do_deploy_state') && q.text.includes('INSERT'));
    expect(upsert).toBeDefined();
    expect(upsert!.values[0]).toBe('app_xyz');
    expect(upsert!.values[1]).toEqual([]);
  });

  it('deleteDurableObject on non-existent name throws NOT_FOUND with no Cloudflare calls', async () => {
    const m = makeMockDb();
    m.queryResults.push({ rows: [] });  // SELECT finds no row

    await expect(
      DurableObjectsService.deleteDurableObject(m.db, 'app_xyz', 'missing'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(CloudflareWfp.deployDoWorker).not.toHaveBeenCalled();
    expect(CloudflareWfp.deleteDoWorker).not.toHaveBeenCalled();
  });
});
