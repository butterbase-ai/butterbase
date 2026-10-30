import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureApprovalOperation } from '../approval-operation.js';
import { PreparedProposalSchema, setApprovalProposalProvider } from '../approval-proposal.js';
import { setOperatorAccessPolicy } from '../operator-access-policy.js';
import { setProposalToolValidator } from '../proposal-validation.js';
import { executeApprovedOperatorTool } from '../substrate-approval-bridge.js';
import { callMcpTool } from '../mcp-client.js';
vi.mock('../mcp-client.js', () => ({ callMcpTool: vi.fn() }));

afterEach(() => { setApprovalProposalProvider(null); setOperatorAccessPolicy(null); setProposalToolValidator(null); vi.clearAllMocks(); });
function setup() {
  const operation = captureApprovalOperation({ toolName: 'butterbase_docs', args: { topic: 'synthetic' } });
  const proposal = PreparedProposalSchema.parse({ version: 1, source: 'explicit', preparedAt: new Date().toISOString(), intentFingerprint: 'a'.repeat(64), operationFingerprint: 'b'.repeat(64), reason: { text: 'Synthetic reason.', attribution: 'operator' }, evidence: [], preview: { title: 'Synthetic?', summary: 'Synthetic only.', target: { label: 'Synthetic', reference: 'synthetic' }, effects: ['Synthetic.'], fields: [] }, preconditions: [{ kind: 'outbox', referenceId: 'obx_synthetic', fingerprint: 'c'.repeat(64) }] });
  const approval = { toolName: operation.toolName, toolArgs: operation.args, conversationId: 'synthetic-conversation', approvedOperation: operation, proposalDetails: proposal };
  const pool = { query: vi.fn(async () => ({ rows: [{ role: 'owner' }] })), connect: vi.fn(async () => { throw Error('must not reach execution'); }) } as any;
  setProposalToolValidator(async (toolName, args) => ({ toolName, args: args as Record<string, unknown> }));
  setApprovalProposalProvider({ enabled: () => false, prepare: vi.fn(), revalidate: async () => ({ status: 'changed', code: 'proposal_state_changed' }) });
  return { pool, opts: { approvalId: 'synthetic-approval', name: approval.toolName, args: approval.toolArgs, jwt: 'synthetic', orgId: 'synthetic-org', actorUserId: 'synthetic-owner', approval, officeConsequential: true } };
}
describe('prepared execution preflight', () => {
  it('rechecks material state with writers disabled and never dispatches changed targets', async () => {
    const { pool, opts } = setup();
    expect(await executeApprovedOperatorTool(pool, opts)).toMatchObject({ ok: false, code: 'proposal_state_changed' });
    expect(pool.connect).not.toHaveBeenCalled(); expect(callMcpTool).not.toHaveBeenCalled();
  });
  it('rechecks current owner, access and provider availability before dispatch', async () => {
    const { pool, opts } = setup();
    pool.query.mockResolvedValueOnce({ rows: [{ role: 'member' }] });
    expect(await executeApprovedOperatorTool(pool, opts)).toMatchObject({ ok: false, code: 'office_access_blocked' });
    setOperatorAccessPolicy({ evaluate: async () => ({ allowed: false, reason: 'office_paused', approvalMode: 'consequential' }) });
    expect(await executeApprovedOperatorTool(pool, opts)).toMatchObject({ ok: false, code: 'office_access_blocked' });
    setOperatorAccessPolicy(null); setApprovalProposalProvider(null);
    expect(await executeApprovedOperatorTool(pool, opts)).toMatchObject({ ok: false, code: 'proposal_review_unavailable' });
    expect(pool.connect).not.toHaveBeenCalled(); expect(callMcpTool).not.toHaveBeenCalled();
  });
  it('treats unavailable deployment storage as retryable, without expiring the saved proposal', async () => {
    const { pool, opts } = setup();
    const args = { app_id: 'app_synthetic' };
    const deployment = { ...opts, name: 'deploy_frontend', args, approval: { ...opts.approval, toolName: 'deploy_frontend', toolArgs: args, approvedOperation: captureApprovalOperation({ toolName: 'deploy_frontend', args }) } };
    expect(await executeApprovedOperatorTool(pool, { ...deployment, treeStore: { load: vi.fn(async () => { throw Error('temporary read error'); }) } as any })).toMatchObject({ ok: false, code: 'proposal_review_unavailable' });
    expect(await executeApprovedOperatorTool(pool, deployment)).toMatchObject({ ok: false, code: 'proposal_review_unavailable' });
    expect(pool.connect).not.toHaveBeenCalled(); expect(callMcpTool).not.toHaveBeenCalled();
  });
});
