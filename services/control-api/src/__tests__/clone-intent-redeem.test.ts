import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';

process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const {
  mockLoad, mockMark, mockStartClone, mockEnqueue, mockResolveOrg, mockControlQuery,
} = vi.hoisted(() => ({
  mockLoad: vi.fn(), mockMark: vi.fn(), mockStartClone: vi.fn(),
  mockEnqueue: vi.fn(), mockResolveOrg: vi.fn(),
  // The control-plane pool is left REAL for clone-jobs.ts so the lost-race test
  // can inspect the disposal statement the route actually issues.
  mockControlQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

vi.mock('../services/clone-intents.js', () => ({
  loadRedeemableIntent: mockLoad,
  markIntentRedeemed: mockMark,
  createCloneIntent: vi.fn(),
  CLONE_INTENT_TTL_MS: 3600_000,
}));
// Only `startClone` is stubbed. `sendStartCloneFailure` is kept REAL on
// purpose: it is the single failure->HTTP mapping, and re-implementing it in
// the mock would make these status-code assertions test the mock instead of
// the shipped mapper.
vi.mock('../services/start-clone.js', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  startClone: mockStartClone,
}));
vi.mock('../services/org-resolver.js', () => ({
  resolveOrganizationId: mockResolveOrg,
  assertOrgMember: vi.fn(),
}));
vi.mock('../services/region-resolver.js', () => ({ resolveAppHomeRegion: vi.fn(async () => 'iad') }));
vi.mock('../services/runtime-db.js', () => ({ getRuntimeDbPool: vi.fn(() => ({ query: vi.fn() })) }));
vi.mock('../services/clone-task-queue.js', () => ({ enqueueCloneTask: mockEnqueue }));

async function buildApp() {
  const { cloneIntentRoutes } = await import('../routes/clone-intent.js');
  const app = Fastify();
  await app.register(fp(async (f) => {
    f.decorate('controlDb', { query: mockControlQuery } as any);
    f.addHook('onRequest', async (req) => { (req as any).auth = { userId: 'usr_1' }; });
  }));
  await app.register(cloneIntentRoutes);
  await app.ready();
  return app;
}

const goodIntent = {
  ok: true,
  intent: {
    id: 'ci_1', source_app_id: 'app_src', dest_app_name: 'my-clone',
    dest_region: 'iad', auto_mint_requests: null, created_at: new Date(),
    expires_at: new Date(Date.now() + 3600_000), redeemed_at: null,
    redeemed_by_user_id: null, resulting_job_id: null,
  },
  envVarValues: { fn: { SECRET: 'hunter2' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveOrg.mockResolvedValue('org_1');
  mockLoad.mockResolvedValue(goodIntent);
  mockMark.mockResolvedValue(true);
  mockStartClone.mockResolvedValue({
    ok: true, jobId: 'cj_1', destAppId: 'app_dst', sourceAppId: 'app_src',
    sourceRegion: 'iad', destRegion: 'iad',
  });
});

describe('POST /v1/clone-intents/:id/redeem', () => {
  it('starts the clone and marks the intent redeemed', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/clone-intents/ci_1/redeem' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ job_id: 'cj_1', dest_region: 'iad' });
    expect(res.body).not.toContain('hunter2');
    // The parked configuration reaches startClone unchanged — including the
    // auto_mint_requests the anonymous endpoint accepted without validating,
    // which startClone runs through validateAutoMintRequests.
    expect(mockStartClone).toHaveBeenCalledWith(expect.objectContaining({
      sourceAppId: 'app_src',
      userId: 'usr_1',
      destOrgId: 'org_1',
      name: 'my-clone',
      envVarValues: goodIntent.envVarValues,
    }));
    expect(mockMark).toHaveBeenCalledWith(expect.anything(), { id: 'ci_1', userId: 'usr_1', jobId: 'cj_1' });
    expect(mockEnqueue).toHaveBeenCalledWith('app_src', 'iad', 'cj_1');
    await app.close();
  });

  it('enqueues only AFTER the intent is marked redeemed', async () => {
    const order: string[] = [];
    mockMark.mockImplementation(async () => { order.push('mark'); return true; });
    mockEnqueue.mockImplementation(async () => { order.push('enqueue'); });
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/v1/clone-intents/ci_1/redeem' });
    expect(order).toEqual(['mark', 'enqueue']);
    await app.close();
  });

  it('does NOT consume the intent when the org is over its project quota', async () => {
    mockStartClone.mockResolvedValue({ ok: false, code: 'QUOTA_EXCEEDED', current: 3, limit: 3 });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/clone-intents/ci_1/redeem' });
    expect(res.statusCode).toBe(403);
    expect(mockMark).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('does NOT consume the intent when the name is taken', async () => {
    mockStartClone.mockResolvedValue({ ok: false, code: 'NAME_TAKEN', name: 'my-clone' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/clone-intents/ci_1/redeem' });
    expect(res.statusCode).toBe(409);
    expect(mockMark).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts a name override on retry after a collision', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST', url: '/v1/clone-intents/ci_1/redeem', payload: { name: 'renamed-clone' },
    });
    expect(mockStartClone).toHaveBeenCalledWith(expect.objectContaining({ name: 'renamed-clone' }));
    await app.close();
  });

  it('redirects to the existing job when already redeemed', async () => {
    mockLoad.mockResolvedValue({ ok: false, reason: 'already_redeemed', jobId: 'cj_prev' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/clone-intents/ci_1/redeem' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ job_id: 'cj_prev' });
    expect(mockStartClone).not.toHaveBeenCalled();
    await app.close();
  });

  it('410s an expired intent', async () => {
    mockLoad.mockResolvedValue({ ok: false, reason: 'expired' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/clone-intents/ci_1/redeem' });
    expect(res.statusCode).toBe(410);
    await app.close();
  });

  // markIntentRedeemed is an atomic conditional claim; a concurrent redemption
  // can win it. The loser must not enqueue its now-orphaned duplicate job, and
  // must report the WINNER's job id — otherwise the caller polls a job that no
  // worker will ever pick up.
  it('reports the winner job and does not enqueue when it loses the claim race', async () => {
    mockMark.mockResolvedValue(false);
    mockLoad
      .mockResolvedValueOnce(goodIntent)
      .mockResolvedValueOnce({ ok: false, reason: 'already_redeemed', jobId: 'cj_winner' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/clone-intents/ci_1/redeem' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ job_id: 'cj_winner' });
    expect(res.json().job_id).not.toBe('cj_1');
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(res.body).not.toContain('hunter2');

    // The duplicate must be disposed of HERE. Nothing in the background covers
    // it: clone-jobs-reaper skips rows still in 'pending' and clone-jobs-pruner
    // only deletes terminal rows, so an un-enqueued job would sit in 'pending'
    // forever — eating one of the user's 3 in-flight clone slots and holding
    // their env var secrets in pending_env_vars indefinitely.
    const disposal = mockControlQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE template_clone_jobs'),
    ) as unknown as [string, unknown[]] | undefined;
    expect(disposal, 'the duplicate job was never disposed of').toBeDefined();
    expect(disposal![0]).toMatch(/status = 'failed'/);
    expect(disposal![0]).toMatch(/pending_env_vars = NULL/);
    expect(disposal![1][0]).toBe('cj_1');
    expect(String(disposal![1][1])).toContain('cj_winner');
    expect(String(disposal![1][1])).not.toContain('hunter2');
    await app.close();
  });
});
