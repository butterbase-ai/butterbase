process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
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
    const c = makeMockDb();
    m.queryResults.push(
      { rows: [{ id: 'do_1' }] },
      { rows: [{ id: 'do_1', name: 'chat-room', class_name: 'ChatRoom', code: 'export class ChatRoom {}', access_mode: 'public' }] },
      { rows: [] }, // No prior deploy state.
      { rows: [{ name: 'app', region: 'us-east-1', anon_key: 'anon', subdomain: null, deployment_url: null, stripe_connect_account_id: null, ai_config: null }] }, // apps row (runtime)
      { rows: [] }, // No app_env_vars.
      { rows: [] }, // No DO env vars.
      { rows: [] },
      { rows: [] },
    );
    c.queryResults.push(
      { rows: [] }, // kv_function_key
    );

    const result = await DurableObjectsService.registerDurableObject(m.db, c.db, 'app_xyz', 'user_1', {
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
    const c = makeMockDb();
    (CloudflareWfp.deployDoWorker as any).mockRejectedValueOnce(new Error('cf 500'));
    m.queryResults.push(
      { rows: [{ id: 'do_1' }] },
      { rows: [{ id: 'do_1', name: 'chat-room', class_name: 'ChatRoom', code: 'export class ChatRoom {}', access_mode: 'public' }] },
      { rows: [] },                // SELECT prev state
      { rows: [{ name: 'app', region: 'us-east-1', anon_key: 'anon', subdomain: null, deployment_url: null, stripe_connect_account_id: null, ai_config: null }] }, // apps row (runtime)
      { rows: [] },                // SELECT app_env_vars
      { rows: [] },                // SELECT do env vars
      { rows: [] },                // UPDATE ERROR
    );
    c.queryResults.push(
      { rows: [] }, // kv_function_key
    );

    await expect(
      DurableObjectsService.registerDurableObject(m.db, c.db, 'app_xyz', 'user_1', {
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
    const c = makeMockDb();
    await expect(
      DurableObjectsService.registerDurableObject(m.db, c.db, 'app_xyz', 'user_1', {
        name: 'Bad Name',
        code: 'export class X {}',
        access_mode: 'public',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_NAME' });
    expect(m.queries.length).toBe(0);
    expect(CloudflareWfp.deployDoWorker).not.toHaveBeenCalled();
  });

  it('rejects extractClassName failure (no class) with NO_EXPORTED_CLASS, no DB writes', async () => {
    const m = makeMockDb();
    const c = makeMockDb();
    await expect(
      DurableObjectsService.registerDurableObject(m.db, c.db, 'app_xyz', 'user_1', {
        name: 'bad',
        code: 'export const foo = 1;',
        access_mode: 'public',
      }),
    ).rejects.toMatchObject({ code: 'NO_EXPORTED_CLASS' });
    expect(m.queries.length).toBe(0);
  });

  it('updating an existing class produces empty new_classes and deleted_classes diff', async () => {
    const m = makeMockDb();
    const c = makeMockDb();
    m.queryResults.push(
      { rows: [{ id: 'do_1' }] },
      { rows: [{ id: 'do_1', name: 'chat-room', class_name: 'ChatRoom', code: 'export class ChatRoom {}', access_mode: 'public' }] },
      { rows: [{ deployed_class_names: ['ChatRoom'] }] },
      { rows: [{ name: 'app', region: 'us-east-1', anon_key: 'anon', subdomain: null, deployment_url: null, stripe_connect_account_id: null, ai_config: null }] }, // apps row (runtime)
      { rows: [] }, // app_env_vars
      { rows: [] }, // do env vars
      { rows: [] },
      { rows: [] },
    );
    c.queryResults.push(
      { rows: [] }, // kv_function_key
    );

    await DurableObjectsService.registerDurableObject(m.db, c.db, 'app_xyz', 'user_1', {
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
    const c = makeMockDb();
    m.queryResults.push(
      { rows: [{ id: 'do_1', class_name: 'ChatRoom' }] }, // SELECT existing row
      { rows: [] }, // DELETE row
      { rows: [{ id: 'do_2', name: 'leaderboard', class_name: 'Leaderboard', code: 'export class Leaderboard {}', access_mode: 'authenticated' }] }, // remaining
      { rows: [{ deployed_class_names: ['ChatRoom', 'Leaderboard'] }] }, // prev state
      { rows: [{ name: 'app', region: 'us-east-1', anon_key: 'anon', subdomain: null, deployment_url: null, stripe_connect_account_id: null, ai_config: null }] }, // apps row (runtime)
      { rows: [] }, // app_env_vars
      { rows: [] }, // do env vars
      { rows: [] }, // UPSERT deploy_state
    );
    c.queryResults.push(
      { rows: [] }, // kv_function_key
    );

    await DurableObjectsService.deleteDurableObject(m.db, c.db, 'app_xyz', 'chat-room');

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

    await DurableObjectsService.deleteDurableObject(m.db, makeMockDb().db, 'app_xyz', 'chat-room');

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
      DurableObjectsService.deleteDurableObject(m.db, makeMockDb().db, 'app_xyz', 'missing'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(CloudflareWfp.deployDoWorker).not.toHaveBeenCalled();
    expect(CloudflareWfp.deleteDoWorker).not.toHaveBeenCalled();
  });
});

describe('bundleAndDeploy env composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (CloudflareWfp.deployDoWorker as any).mockResolvedValue({ newTag: 'v-env' });
    (CloudflareWfp.deleteDoWorker as any).mockResolvedValue(undefined);
    ((CloudflareWfp as any).getDoWorkerMigrationTag as any).mockResolvedValue(null);
  });

  it('passes platform + app + do env vars to CF deploy in correct precedence', async () => {
    const { encrypt } = await import('../crypto.js');
    const runtimeMock = makeMockDb();
    const controlMock = makeMockDb();
    const encKey = process.env.AUTH_ENCRYPTION_KEY!;
    const appId = 'app_env_composition';

    // Runtime DB call order (apps lives on runtime plane):
    //  1. INSERT INTO app_durable_objects ... RETURNING id
    //  2. SELECT active classes
    //  3. SELECT prev deploy state
    //  4. SELECT apps row (resolvePlatformDoEnv — runtime!)
    //  5. SELECT encrypted_env_vars FROM app_env_vars
    //  6. SELECT key, encrypted_value FROM app_do_env_vars
    //  7. INSERT INTO app_do_deploy_state ... ON CONFLICT DO UPDATE
    //  8. UPDATE app_durable_objects SET status='READY'
    runtimeMock.queryResults.push(
      { rows: [{ id: 'do_1' }] },
      { rows: [{ id: 'do_1', name: 'widget-ticket-do', class_name: 'WidgetTicketDo',
                 code: 'export class WidgetTicketDo { async fetch() { return new Response("ok"); } }',
                 access_mode: 'public' }] },
      { rows: [] },
      {
        rows: [{
          name: 'my-app', region: 'us-east-1', anon_key: 'anon_xyz',
          subdomain: 'my-app', deployment_url: null,
          stripe_connect_account_id: null, ai_config: null,
        }],
      },
      { rows: [{ encrypted_env_vars: encrypt(JSON.stringify({
          STRIPE_SECRET: 'sk_app',
          BUTTERBASE_APP_ID: 'spoofed',
        }), encKey) }] },
      { rows: [{ key: 'STRIPE_SECRET', encrypted_value: encrypt('sk_do_override', encKey) }] },
      { rows: [] },
      { rows: [] },
    );

    // Control DB order (only app_kv_credentials):
    //  1. SELECT kv_function_key (fetchInternalFnKeyForApp)
    controlMock.queryResults.push(
      { rows: [{ kv_function_key: 'kv_internal_xyz' }] },
    );

    await DurableObjectsService.registerDurableObject(
      runtimeMock.db, controlMock.db, appId, 'user_1',
      {
        name: 'widget-ticket-do',
        code: 'export class WidgetTicketDo { async fetch() { return new Response("ok"); } }',
        access_mode: 'public',
      },
    );

    expect(CloudflareWfp.deployDoWorker).toHaveBeenCalledOnce();
    const call = (CloudflareWfp.deployDoWorker as any).mock.calls[0][0];
    expect(call.envVars.STRIPE_SECRET).toBe('sk_do_override');
    expect(call.envVars.BUTTERBASE_APP_ID).toBe(appId);
    expect(call.envVars.BUTTERBASE_APP_NAME).toBe('my-app');
    expect(call.envVars.BUTTERBASE_REGION).toBe('us-east-1');
    expect(call.envVars.BUTTERBASE_ANON_KEY).toBe('anon_xyz');
    expect(call.envVars.BUTTERBASE_SUBDOMAIN).toBe('my-app');
    expect(call.envVars.BUTTERBASE_INTERNAL_FN_KEY).toBe('kv_internal_xyz');
    expect(call.envVars.BUTTERBASE_API_URL).toMatch(/^https?:\/\//);
  });
});

describe('setDoEnvVar reserved prefix', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('rejects BUTTERBASE_* keys with RESERVED_ENV_KEY code', async () => {
    const m = makeMockDb();
    await expect(
      DurableObjectsService.setDoEnvVar(m.db, makeMockDb().db, 'app_xyz', 'BUTTERBASE_APP_ID', 'spoofed')
    ).rejects.toMatchObject({
      name: 'DurableObjectError',
      code: 'RESERVED_ENV_KEY',
    });
    expect(m.queries).toHaveLength(0);
  });

  it('accepts non-reserved keys and returns redeployed=false when no active classes', async () => {
    const m = makeMockDb();
    m.queryResults.push(
      { rows: [] }, // INSERT INTO app_do_env_vars (upsert)
      { rows: [] }, // SELECT active classes for maybeRedeploy → empty
    );
    const res = await DurableObjectsService.setDoEnvVar(m.db, makeMockDb().db, 'app_xyz', 'STRIPE_SECRET', 'sk_test_x');
    expect(res).toEqual({ redeployed: false });
  });
});
