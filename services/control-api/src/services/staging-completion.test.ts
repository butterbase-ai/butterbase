import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  linkEnvironments: vi.fn(),
  isolateStagingApp: vi.fn(),
  isolateStagingMeetingsWebhook: vi.fn(),
}));
vi.mock('./app-environments.js', () => ({ linkEnvironments: mocks.linkEnvironments }));
vi.mock('./staging-isolation.js', () => ({
  isolateStagingApp: mocks.isolateStagingApp,
  isolateStagingMeetingsWebhook: mocks.isolateStagingMeetingsWebhook,
}));

import { finalizeStagingClone } from './staging-completion.js';

const job = {
  id: 'job_1', mode: 'staging_create', source_app_id: 'app_prod',
  dest_app_id: 'app_staging', requested_by_user_id: 'u1',
} as never;

const RUNTIME_DB = { plane: 'runtime' } as never;
const CONTROL_DB = { plane: 'control' } as never;

beforeEach(() => vi.clearAllMocks());

describe('finalizeStagingClone', () => {
  it('links prod to staging', async () => {
    await finalizeStagingClone(RUNTIME_DB, CONTROL_DB, job);
    expect(mocks.linkEnvironments).toHaveBeenCalledWith(RUNTIME_DB, {
      prodAppId: 'app_prod', stagingAppId: 'app_staging', createdBy: 'u1',
    });
  });

  it('does nothing for a plain clone', async () => {
    await finalizeStagingClone(RUNTIME_DB, CONTROL_DB, { ...(job as object), mode: 'clone' } as never);
    expect(mocks.linkEnvironments).not.toHaveBeenCalled();
    expect(mocks.isolateStagingApp).not.toHaveBeenCalled();
    expect(mocks.isolateStagingMeetingsWebhook).not.toHaveBeenCalled();
  });

  it('throws when the destination app id is missing, rather than linking null', async () => {
    await expect(
      finalizeStagingClone(RUNTIME_DB, CONTROL_DB, { ...(job as object), dest_app_id: null } as never),
    ).rejects.toThrow(/dest_app_id/);
  });

  it('isolates the staging app before linking it', async () => {
    const order: string[] = [];
    mocks.isolateStagingApp.mockImplementation(async () => { order.push('isolate'); });
    mocks.linkEnvironments.mockImplementation(async () => { order.push('link'); });
    await finalizeStagingClone(RUNTIME_DB, CONTROL_DB, job);
    expect(order).toEqual(['isolate', 'link']);
  });

  it('isolates the control-plane meetings webhook, on the control pool, before linking', async () => {
    const order: string[] = [];
    mocks.isolateStagingMeetingsWebhook.mockImplementation(async () => { order.push('isolate-webhook'); });
    mocks.linkEnvironments.mockImplementation(async () => { order.push('link'); });
    await finalizeStagingClone(RUNTIME_DB, CONTROL_DB, job);
    expect(order).toEqual(['isolate-webhook', 'link']);
    expect(mocks.isolateStagingMeetingsWebhook).toHaveBeenCalledWith(CONTROL_DB, 'app_staging');
  });
});
