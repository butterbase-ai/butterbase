import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll, type MockedFunction } from 'vitest';

vi.mock('../../services/dashboard-agent/approvals-store.js', () => ({
  getApprovalForOrg: vi.fn(),
  listPendingByOrg: vi.fn(),
  resolveApproval: vi.fn(),
}));
vi.mock('../../services/dashboard-agent/tool-bridge.js', () => ({ executeOnce: vi.fn() }));

import { Pool } from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import * as approvalsModule from '../../services/dashboard-agent/approvals-store.js';
import * as bridgeModule from '../../services/dashboard-agent/tool-bridge.js';
import { resolveOperatorApproval, resolveCallerOrgId, dashboardAgentRoutes } from '../dashboard-agent.js';

const mockGet = approvalsModule.getApprovalForOrg as MockedFunction<typeof approvalsModule.getApprovalForOrg>;
const mockResolve = approvalsModule.resolveApproval as MockedFunction<typeof approvalsModule.resolveApproval>;
const mockExecute = bridgeModule.executeOnce as MockedFunction<typeof bridgeModule.executeOnce>;

const stubPool = {} as any;
const approval = {
  id: 'appr-1', conversationId: 'conv-1', turnMessageId: 'msg-1',
  toolName: 'manage_substrate', toolArgs: { action: 'propose' },
  sensitivity: 'destructive' as const, status: 'pending' as const,
  trustScope: null, denyReason: null, createdAt: '', resolvedAt: null,
};

beforeEach(() => { vi.clearAllMocks(); });

describe('resolveOperatorApproval', () => {
  it('404s when the approval is not in the caller org', async () => {
    mockGet.mockResolvedValue(null);
    const r = await resolveOperatorApproval(stubPool, {
      approvalId: 'appr-1', orgId: 'org-x', jwt: 'k', resolution: { status: 'approved' },
    });
    expect(r).toEqual({ ok: false, code: 404, error: 'approval not found' });
  });

  it('executes through the bridge exactly once on approve', async () => {
    mockGet.mockResolvedValue(approval);
    mockExecute.mockResolvedValue({ ok: true, result: { id: 'act_1' } });
    mockResolve.mockResolvedValue(true);

    const r = await resolveOperatorApproval(stubPool, {
      approvalId: 'appr-1', orgId: 'org-1', jwt: 'k', resolution: { status: 'approved' },
    });

    expect(r.ok).toBe(true);
    expect(mockExecute).toHaveBeenCalledWith(stubPool, {
      approvalId: 'appr-1', name: 'manage_substrate',
      args: { action: 'propose' }, jwt: 'k', orgId: 'org-1',
    });
  });

  it('does not execute on deny', async () => {
    mockGet.mockResolvedValue(approval);
    mockResolve.mockResolvedValue(true);

    await resolveOperatorApproval(stubPool, {
      approvalId: 'appr-1', orgId: 'org-1', jwt: 'k',
      resolution: { status: 'denied', reason: 'no' },
    });

    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('409s when the approval is no longer pending', async () => {
    mockGet.mockResolvedValue({ ...approval, status: 'approved' });
    const r = await resolveOperatorApproval(stubPool, {
      approvalId: 'appr-1', orgId: 'org-1', jwt: 'k', resolution: { status: 'approved' },
    });
    expect(r).toEqual({ ok: false, code: 409, error: 'approval is not pending' });
  });

  it('does not execute when a concurrent caller already claimed the approval', async () => {
    // getApprovalForOrg read it as pending, but the conditional UPDATE loses the
    // race. The bridge's advisory lock still guarantees one execution.
    mockGet.mockResolvedValue(approval);
    mockExecute.mockResolvedValue({ ok: true, result: { id: 'act_1' } });
    mockResolve.mockResolvedValue(false);

    const r = await resolveOperatorApproval(stubPool, {
      approvalId: 'appr-1', orgId: 'org-1', jwt: 'k', resolution: { status: 'approved' },
    });
    expect(r).toEqual({ ok: false, code: 409, error: 'approval is not pending' });
  });

  it('502s and leaves the approval pending when the bridge rejects the tool', async () => {
    mockGet.mockResolvedValue(approval);
    mockExecute.mockResolvedValue({ ok: false, error: 'tool "manage_app" is not permitted for the operator' });

    const r = await resolveOperatorApproval(stubPool, {
      approvalId: 'appr-1', orgId: 'org-1', jwt: 'k', resolution: { status: 'approved' },
    });

    expect(r).toEqual({
      ok: false, code: 502, error: 'tool "manage_app" is not permitted for the operator',
    });
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Membership gate (real control-plane DB).
//
// `x-organization-id` is a client-supplied header. Every operator approval
// route MUST prove the authenticated caller is actually a member of that org
// before it is used as a scope, or any logged-in user could list and resolve
// another org's approvals by changing one header.
// ---------------------------------------------------------------------------

const dbPool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });
const ORG_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const ORG_B = '22222222-bbbb-4bbb-8bbb-222222222222';
const MEMBER = '33333333-cccc-4ccc-8ccc-333333333333';

async function cleanup() {
  await dbPool.query(`DELETE FROM organization_members WHERE organization_id = ANY($1)`, [[ORG_A, ORG_B]]);
  await dbPool.query(`DELETE FROM platform_users WHERE id = $1`, [MEMBER]);
  await dbPool.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[ORG_A, ORG_B]]);
}

beforeAll(async () => {
  await cleanup();
  await dbPool.query(
    `INSERT INTO organizations (id, name, owner_id, personal) VALUES ($1, 'A', $3, false), ($2, 'B', $3, false)`,
    [ORG_A, ORG_B, MEMBER],
  );
  await dbPool.query(
    `INSERT INTO platform_users (id, email, personal_organization_id) VALUES ($1, $2, $3)`,
    [MEMBER, `operator-approvals-test-${MEMBER}@example.test`, ORG_A],
  );
  await dbPool.query(
    `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ORG_A, MEMBER],
  );
});

afterAll(async () => {
  await cleanup();
  await dbPool.end();
});

describe('resolveCallerOrgId', () => {
  it('returns the org id when the caller is a member', async () => {
    const r = await resolveCallerOrgId(dbPool, { headers: { 'x-organization-id': ORG_A } }, MEMBER);
    expect(r).toEqual({ ok: true, orgId: ORG_A });
  });

  it('403s when the caller passes an org id they are not a member of', async () => {
    const r = await resolveCallerOrgId(dbPool, { headers: { 'x-organization-id': ORG_B } }, MEMBER);
    expect(r).toEqual({ ok: false, code: 403, error: 'not a member of the requested organization' });
  });

  it('400s when the header is absent', async () => {
    const r = await resolveCallerOrgId(dbPool, { headers: {} }, MEMBER);
    expect(r).toEqual({ ok: false, code: 400, error: 'x-organization-id required' });
  });

  // organization_members.organization_id is `uuid`, so Postgres normalises a
  // non-canonical header and the membership check passes. But
  // dashboard_agent_conversations.organization_id is TEXT and compared exactly,
  // so echoing the header back would give a legitimate member a silent 404 on
  // every approval. Return the database's own canonical form instead.
  it('returns the canonical org id from the database, not the header string', async () => {
    const r = await resolveCallerOrgId(
      dbPool,
      { headers: { 'x-organization-id': ORG_A.toUpperCase() } },
      MEMBER,
    );
    expect(r).toEqual({ ok: true, orgId: ORG_A });
  });

  it('400s a non-uuid header rather than 500ing on a Postgres cast error', async () => {
    const r = await resolveCallerOrgId(dbPool, { headers: { 'x-organization-id': 'not-a-uuid' } }, MEMBER);
    expect(r).toEqual({ ok: false, code: 400, error: 'x-organization-id must be a uuid' });
  });
});

// ---------------------------------------------------------------------------
// Route wiring. Proves both operator routes actually invoke the membership
// gate — testing resolveCallerOrgId in isolation would stay green if a future
// edit dropped the call from one of them.
//
// Auth is stubbed by decorating request.auth (same pattern as
// dashboard-agent.test.ts); controlDb is a stub whose membership SELECT
// returns no rows, i.e. the caller is not a member.
// ---------------------------------------------------------------------------

describe('operator route membership wiring', () => {
  let app: FastifyInstance;
  const query = vi.fn();

  beforeEach(async () => {
    process.env.DASHBOARD_ASSISTANT_ENABLED = '1';
    query.mockReset();
    query.mockResolvedValue({ rows: [], rowCount: 0 });

    app = Fastify({ logger: false });
    app.decorateRequest('auth', null as any);
    app.addHook('onRequest', async (request) => {
      (request as any).auth = { userId: 'some-user', authMethod: 'jwt', scopes: ['*'] };
    });
    app.decorate('controlDb', { query } as any);
    await app.register(dashboardAgentRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    delete process.env.DASHBOARD_ASSISTANT_ENABLED;
  });

  it('GET /operator/approvals 403s a non-member', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/operator/approvals',
      headers: { 'x-organization-id': ORG_B },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'not a member of the requested organization' });
    expect(approvalsModule.listPendingByOrg).not.toHaveBeenCalled();
  });

  it('POST /operator/approvals/:id/resolve 403s a non-member', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/operator/approvals/appr-1/resolve',
      headers: { 'x-organization-id': ORG_B },
      payload: { status: 'approved' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'not a member of the requested organization' });
    expect(approvalsModule.getApprovalForOrg).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('GET /operator/approvals 400s when the header is absent', async () => {
    const res = await app.inject({ method: 'GET', url: '/operator/approvals' });
    expect(res.statusCode).toBe(400);
    expect(approvalsModule.listPendingByOrg).not.toHaveBeenCalled();
  });
});
