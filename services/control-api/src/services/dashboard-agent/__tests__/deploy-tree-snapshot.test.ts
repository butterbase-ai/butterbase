/**
 * Execute an approved deployment from its persisted tree.
 *
 * The production failure: the approval is created on API machine A; Fly routes
 * the resolve to machine B, whose process-local `WorkingTreeCache` is empty.
 * The approval row has the right digest and arguments, but `deploy.ts` sees an
 * empty tree and returns "no files to deploy" — or the request hangs until a
 * 502. The proposal now persists the tree under the approval id; this file
 * proves the execution path uses it, and refuses when it is gone.
 *
 * Postgres, the exactly-once bridge and the HTTP deploy transports are mocked:
 * those are covered by their own suites. What is under test here is the
 * hand-off between the snapshot and the deployer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { executeApprovedOperatorTool } from '../substrate-approval-bridge.js';
import { executeOnce } from '../tool-bridge.js';
import { createDeployer } from '../deploy.js';
import { createFunctionDeployer } from '../deploy-function.js';
import { createHttpFrontendMcp } from '../frontend-http.js';
import { createHttpFunctionMcp } from '../function-http.js';
import { captureApprovalOperation, functionSourceArtifact, workingTreeArtifact } from '../approval-operation.js';
import { createDeployTreeStore, type DeployTreeRedis } from '../deploy-tree-store.js';
import { WorkingTreeCache, type WorkingTree } from '../working-tree.js';
import { PreparedProposalSchema, proposalFingerprint, proposalIntentFingerprint, setApprovalProposalProvider } from '../approval-proposal.js';
import { createProposalToolValidator, setProposalToolValidator } from '../proposal-validation.js';

vi.mock('../tool-bridge.js', () => ({ executeOnce: vi.fn() }));
vi.mock('../deploy.js', () => ({ createDeployer: vi.fn() }));
vi.mock('../deploy-function.js', () => ({ createFunctionDeployer: vi.fn() }));
vi.mock('../frontend-http.js', () => ({ createHttpFrontendMcp: vi.fn(() => ({ call: vi.fn() })) }));
vi.mock('../function-http.js', () => ({ createHttpFunctionMcp: vi.fn(() => ({ call: vi.fn() })) }));

const mockExecuteOnce = vi.mocked(executeOnce);
const mockCreateDeployer = vi.mocked(createDeployer);
const mockCreateFunctionDeployer = vi.mocked(createFunctionDeployer);
const mockCreateHttpFrontendMcp = vi.mocked(createHttpFrontendMcp);
const mockCreateHttpFunctionMcp = vi.mocked(createHttpFunctionMcp);

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
// Authorization queries are outside this snapshot hand-off unit; the real
// route suites exercise membership. No database or HTTP transport is reached.
const ownerPool = { query: vi.fn(async (_sql: string, params: unknown[]) => ({
  rows: params[0] === ORG_ID && params[1] === OWNER_ID ? [{ role: 'owner' }] : [],
})) } as unknown as pg.Pool;

type Stored = { value: Buffer; ttl: number };
function fakeRedis() {
  const data = new Map<string, Stored>();
  const redis: DeployTreeRedis = {
    async set(key, value, mode, ttl) {
      if (mode !== 'EX') throw new Error('expected EX');
      data.set(key, { value: Buffer.isBuffer(value) ? value : Buffer.from(value), ttl });
      return 'OK';
    },
    async getBuffer(key) {
      return data.get(key)?.value ?? null;
    },
  };
  return { redis, data };
}

function tree(files: Array<{ path: string; content: string }>): WorkingTree {
  const t: WorkingTree = new Map();
  for (const f of files) {
    t.set(f.path, {
      path: f.path,
      content: f.content,
      sha256: sha(f.content),
    });
  }
  return t;
}

function sha(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const SAMPLE = tree([
  { path: 'package.json', content: '{"scripts":{"build":"vite build"}}' },
  { path: 'index.html', content: '<div id="root"></div>' },
  { path: 'src/main.tsx', content: 'console.log("hello")' },
]);

const FUNCTION_TREE = tree([
  { path: 'functions/send-receipt/index.ts', content: 'export const handler = 1' },
]);

let deployedFiles: string[] | null = null;
let deployedFunctionFiles: string[] | null = null;
let deployedEntrySource: string | null = null;
let deployedFunctionSource: string | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  deployedFiles = null;
  deployedFunctionFiles = null;
  deployedEntrySource = null;
  deployedFunctionSource = null;
  setProposalToolValidator(await createProposalToolValidator(() => {}));
  setApprovalProposalProvider({
    enabled: () => true,
    prepare: async () => ({ status: 'blocked', code: 'proposal_unreviewable', message: 'Fixture metadata is prepared directly.' }),
    revalidate: async (context, saved) => proposalFingerprint(context.operation) === saved.operationFingerprint
      ? { status: 'valid' } : { status: 'changed', code: 'proposal_state_changed' },
  });

  mockExecuteOnce.mockImplementation((async (_pool: unknown, opts: unknown) => {
    const call = opts as {
      name: string;
      args: unknown;
      dispatch?: (input: { name: string; args: unknown }) => Promise<unknown>;
    };
    if (!call.dispatch) return { ok: true, result: { ok: true } };
    return call.dispatch({ name: call.name, args: call.args });
  }) as never);

  mockCreateDeployer.mockImplementation(((deps: {
    cache: WorkingTreeCache;
  }) => ({
    deploy: async ({ convId, appId }: { convId: string; appId: string }) => {
      const t = deps.cache.get(convId, appId);
      deployedFiles = t ? Array.from(t.keys()).sort() : null;
      deployedEntrySource = t?.get('src/main.tsx')?.content ?? null;
      return { ok: true, deployment_id: 'dep-1', url: 'https://app.test' };
    },
  })) as never);

  mockCreateFunctionDeployer.mockImplementation(((deps: {
    cache: WorkingTreeCache;
  }) => ({
    deploy: async ({ convId, appId }: { convId: string; appId: string }) => {
      const t = deps.cache.get(convId, appId);
      deployedFunctionFiles = t ? Array.from(t.keys()).sort() : null;
      deployedFunctionSource = t?.get('functions/send-receipt/index.ts')?.content ?? null;
      return { ok: true, url: 'https://fn.test', deploymentId: 'dep-fn' };
    },
  })) as never);

  mockCreateHttpFrontendMcp.mockReturnValue({ call: vi.fn() } as never);
  mockCreateHttpFunctionMcp.mockReturnValue({ call: vi.fn() } as never);
});

afterEach(() => {
  setApprovalProposalProvider(null);
  setProposalToolValidator(null);
});

function approvalFor(toolName: string, args: unknown, artifact: ReturnType<typeof workingTreeArtifact>) {
  const operation = captureApprovalOperation({ toolName, args, artifact });
  return {
    conversationId: 'conv-1',
    toolName,
    toolArgs: args,
    approvedOperation: operation,
    proposalDetails: PreparedProposalSchema.parse({
      version: 1, source: 'intercepted', preparedAt: new Date().toISOString(),
      operationFingerprint: proposalFingerprint(operation),
      intentFingerprint: proposalIntentFingerprint(toolName, args, artifact),
      reason: { text: 'Apply this exact reviewed fixture snapshot.', attribution: 'operator' }, evidence: [],
      preview: {
        title: 'Execute the fixture operation?', summary: 'Use the saved fixture source and arguments.',
        target: { label: 'Fixture app', reference: 'app-1' }, effects: ['Executes this recorded operation.'], fields: [],
        ...(artifact ? { artifact } : {}),
      },
      preconditions: [{ kind: 'app', referenceId: 'app-1', fingerprint: proposalFingerprint({ fixture: 'app-1' }) }],
    }),
  };
}

describe('executeApprovedOperatorTool — deploy tree snapshot', () => {
  it('executes a frontend deploy on a machine whose process cache is empty', async () => {
    const { redis } = fakeRedis();
    const store = createDeployTreeStore({ redis });
    await store.save('approval-1', SAMPLE);

    const result = await executeApprovedOperatorTool(ownerPool, {
      approvalId: 'approval-1',
      name: 'deploy_frontend',
      args: { app_id: 'app-1' },
      jwt: 'approver-jwt',
      orgId: ORG_ID,
      actorUserId: OWNER_ID,
      approval: approvalFor('deploy_frontend', { app_id: 'app-1' }, workingTreeArtifact('app-1', SAMPLE)),
      officeConsequential: true,
      cache: new WorkingTreeCache(), // empty: a different API instance
      treeStore: store,
    });

    expect(result.ok).toBe(true);
    expect(deployedFiles).toEqual(['index.html', 'package.json', 'src/main.tsx']);
    expect(deployedEntrySource).toBe('console.log("hello")');
  });

  it('executes a function deploy from the snapshot', async () => {
    const { redis } = fakeRedis();
    const store = createDeployTreeStore({ redis });
    await store.save('approval-2', FUNCTION_TREE);
    const args = { app_id: 'app-1', function_name: 'send-receipt' };

    const result = await executeApprovedOperatorTool(ownerPool, {
      approvalId: 'approval-2',
      name: 'deploy_function_from_workspace',
      args,
      jwt: 'approver-jwt',
      orgId: ORG_ID,
      actorUserId: OWNER_ID,
      approval: approvalFor(
        'deploy_function_from_workspace',
        args,
        functionSourceArtifact('app-1:send-receipt', 'send-receipt', FUNCTION_TREE),
      ),
      officeConsequential: true,
      cache: new WorkingTreeCache(),
      treeStore: store,
    });

    expect(result.ok).toBe(true);
    expect(deployedFunctionFiles).toEqual(['functions/send-receipt/index.ts']);
    expect(deployedFunctionSource).toBe('export const handler = 1');
  });

  it('deploys saved source A even when the receiving process has source B at the same paths', async () => {
    const { redis } = fakeRedis();
    const store = createDeployTreeStore({ redis });
    await store.save('approval-saved-source', SAMPLE);
    const cache = new WorkingTreeCache();
    cache.set('conv-1', 'app-1', tree([
      { path: 'package.json', content: '{"scripts":{"build":"vite build"}}' },
      { path: 'index.html', content: '<div id="root"></div>' },
      { path: 'src/main.tsx', content: 'console.log("unapproved source B")' },
    ]));

    const result = await executeApprovedOperatorTool(ownerPool, {
      approvalId: 'approval-saved-source', name: 'deploy_frontend', args: { app_id: 'app-1' },
      jwt: 'approver-jwt', orgId: ORG_ID, actorUserId: OWNER_ID,
      approval: approvalFor('deploy_frontend', { app_id: 'app-1' }, workingTreeArtifact('app-1', SAMPLE)),
      officeConsequential: true, cache, treeStore: store,
    });

    expect(result.ok).toBe(true);
    expect(deployedEntrySource).toBe('console.log("hello")');
    expect(cache.get('conv-1', 'app-1')?.get('src/main.tsx')?.content).toBe('console.log("unapproved source B")');
  });

  it('refuses a deploy with no snapshot before touching the database or a transport', async () => {
    const { redis } = fakeRedis();
    const store = createDeployTreeStore({ redis });

    const result = await executeApprovedOperatorTool(ownerPool, {
      approvalId: 'approval-missing',
      name: 'deploy_frontend',
      args: { app_id: 'app-1' },
      jwt: 'approver-jwt',
      orgId: ORG_ID,
      actorUserId: OWNER_ID,
      approval: approvalFor('deploy_frontend', { app_id: 'app-1' }, workingTreeArtifact('app-1', SAMPLE)),
      officeConsequential: true,
      cache: new WorkingTreeCache(),
      treeStore: store,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('proposal_review_unavailable');
    expect(ownerPool.query).not.toHaveBeenCalled();
    expect(mockExecuteOnce).not.toHaveBeenCalled();
    expect(mockCreateDeployer).not.toHaveBeenCalled();
  });

  it('refuses a snapshot whose digest is not the approved artifact', async () => {
    const { redis } = fakeRedis();
    const store = createDeployTreeStore({ redis });
    const differentTree = tree([
      { path: 'package.json', content: '{"scripts":{"build":"rm -rf dist"}}' },
      { path: 'index.html', content: '<div id="root">changed</div>' },
    ]);
    await store.save('approval-3', differentTree);

    const result = await executeApprovedOperatorTool(ownerPool, {
      approvalId: 'approval-3',
      name: 'deploy_frontend',
      args: { app_id: 'app-1' },
      jwt: 'approver-jwt',
      orgId: ORG_ID,
      actorUserId: OWNER_ID,
      approval: approvalFor('deploy_frontend', { app_id: 'app-1' }, workingTreeArtifact('app-1', SAMPLE)),
      officeConsequential: true,
      cache: new WorkingTreeCache(),
      treeStore: store,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('approval_operation_changed');
    expect(mockExecuteOnce).not.toHaveBeenCalled();
  });

  it('leaves non-deploy approvals unchanged and never reads the store', async () => {
    const load = vi.fn(async () => null);
    const save = vi.fn(async () => true);

    const result = await executeApprovedOperatorTool(ownerPool, {
      approvalId: 'approval-4',
      name: 'select_rows',
      args: { app_id: 'app-1', table: 'tickets' },
      jwt: 'approver-jwt',
      orgId: ORG_ID,
      actorUserId: OWNER_ID,
      approval: approvalFor('select_rows', { app_id: 'app-1', table: 'tickets' }, undefined),
      officeConsequential: true,
      cache: new WorkingTreeCache(),
      treeStore: { load, save },
    });

    expect(result.ok).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(mockExecuteOnce).toHaveBeenCalledTimes(1);
  });
});
