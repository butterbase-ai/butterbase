import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ linkEnvironments: vi.fn(), isolateStagingApp: vi.fn() }));
vi.mock('./app-environments.js', () => ({ linkEnvironments: mocks.linkEnvironments }));
vi.mock('./staging-isolation.js', () => ({ isolateStagingApp: mocks.isolateStagingApp }));

import { finalizeStagingClone } from './staging-completion.js';

const job = {
  id: 'job_1', mode: 'staging_create', source_app_id: 'app_prod',
  dest_app_id: 'app_staging', requested_by_user_id: 'u1',
} as never;

beforeEach(() => vi.clearAllMocks());

describe('finalizeStagingClone', () => {
  it('links prod to staging', async () => {
    await finalizeStagingClone({} as never, job);
    expect(mocks.linkEnvironments).toHaveBeenCalledWith({}, {
      prodAppId: 'app_prod', stagingAppId: 'app_staging', createdBy: 'u1',
    });
  });

  it('does nothing for a plain clone', async () => {
    await finalizeStagingClone({} as never, { ...(job as object), mode: 'clone' } as never);
    expect(mocks.linkEnvironments).not.toHaveBeenCalled();
  });

  it('throws when the destination app id is missing, rather than linking null', async () => {
    await expect(
      finalizeStagingClone({} as never, { ...(job as object), dest_app_id: null } as never),
    ).rejects.toThrow(/dest_app_id/);
  });

  it('isolates the staging app before linking it', async () => {
    const order: string[] = [];
    mocks.isolateStagingApp.mockImplementation(async () => { order.push('isolate'); });
    mocks.linkEnvironments.mockImplementation(async () => { order.push('link'); });
    await finalizeStagingClone({} as never, job);
    expect(order).toEqual(['isolate', 'link']);
  });
});
