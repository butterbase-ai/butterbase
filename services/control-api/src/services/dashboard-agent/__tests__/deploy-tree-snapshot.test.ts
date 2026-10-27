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
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

beforeEach(() => {
  vi.clearAllMocks();
  deployedFiles = null;
  deployedFunctionFiles = null;

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
      return { ok: true, deployment_id: 'dep-1', url: 'https://app.test' };
    },
  })) as never);

  mockCreateFunctionDeployer.mockImplementation(((deps: {
    cache: WorkingTreeCache;
  }) => ({
    deploy: async ({ convId, appId }: { convId: string; appId: string }) => {
      const t = deps.cache.get(convId, appId);
      deployedFunctionFiles = t ? Array.from(t.keys()).sort() : null;
      return { ok: true, url: 'https://fn.test', deploymentId: 'dep-fn' };
    },
  })) as never);

  mockCreateHttpFrontendMcp.mockReturnValue({ call: vi.fn() } as never);
  mockCreateHttpFunctionMcp.mockReturnValue({ call: vi.fn() } as never);
});

function approvalFor(toolName: string, args: unknown, artifact: ReturnType<typeof workingTreeArtifact>) {
  return {
    conversationId: 'conv-1',
    approvedOperation: captureApprovalOperation({ toolName, args, artifact }),
  };
}

describe('executeApprovedOperatorTool — deploy tree snapshot', () => {
  it('executes a frontend deploy on a machine whose process cache is empty', async () => {
    const { redis } = fakeRedis();
    const store = createDeployTreeStore({ redis });
    await store.save('approval-1', SAMPLE);

    const result = await executeApprovedOperatorTool({} as pg.Pool, {
      approvalId: 'approval-1',
      name: 'deploy_frontend',
      args: { app_id: 'app-1' },
      jwt: 'approver-jwt',
      orgId: ORG_ID,
      approval: approvalFor('deploy_frontend', { app_id: 'app-1' }, workingTreeArtifact('app-1', SAMPLE)),
      officeConsequential: true,
      cache: new WorkingTreeCache(), // empty: a different API instance
      treeStore: store,
    });

    expect(result.ok).toBe(true);
    expect(deployedFiles).toEqual(['index.html', 'package.json', 'src/main.tsx']);
  });

  it('executes a function deploy from the snapshot', async () => {
    const { redis } = fakeRedis();
    const store = createDeployTreeStore({ redis });
    await store.save('approval-2', FUNCTION_TREE);
    const args = { app_id: 'app-1', function_name: 'send-receipt' };

    const result = await executeApprovedOperatorTool({} as pg.Pool, {
      approvalId: 'approval-2',
      name: 'deploy_function_from_workspace',
      args,
      jwt: 'approver-jwt',
      orgId: ORG_ID,
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
  });

  it('refuses a deploy with no snapshot before touching the database or a transport', async () => {
    const { redis } = fakeRedis();
    const store = createDeployTreeStore({ redis });

    const result = await executeApprovedOperatorTool({} as pg.Pool, {
      approvalId: 'approval-missing',
      name: 'deploy_frontend',
      args: { app_id: 'app-1' },
      jwt: 'approver-jwt',
      orgId: ORG_ID,
      approval: approvalFor('deploy_frontend', { app_id: 'app-1' }, workingTreeArtifact('app-1', SAMPLE)),
      officeConsequential: true,
      cache: new WorkingTreeCache(),
      treeStore: store,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('approval_operation_changed');
    expect(result.error).toContain('deploy_tree_unavailable');
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

    const result = await executeApprovedOperatorTool({} as pg.Pool, {
      approvalId: 'approval-3',
      name: 'deploy_frontend',
      args: { app_id: 'app-1' },
      jwt: 'approver-jwt',
      orgId: ORG_ID,
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

    const result = await executeApprovedOperatorTool({} as pg.Pool, {
      approvalId: 'approval-4',
      name: 'select_rows',
      args: { app_id: 'app-1' },
      jwt: 'approver-jwt',
      orgId: ORG_ID,
      approval: approvalFor('select_rows', { app_id: 'app-1' }, undefined),
      officeConsequential: true,
      cache: new WorkingTreeCache(),
      treeStore: { load, save },
    });

    expect(result.ok).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(mockExecuteOnce).toHaveBeenCalledTimes(1);
  });
});
