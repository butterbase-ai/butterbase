/**
 * Task 8 — the immutable approval operation.
 *
 * An approval authorises the RECORDED operation and arguments, not a standing
 * permission and not "whatever the workspace says when the click lands". The
 * failure this file pins:
 *
 *   The operator proposes deploying artifact A. Before the owner clicks, the
 *   working tree changes to B (another wake, another fix, a retry). A naive
 *   replay reads the CURRENT tree and ships B under A's approval. That is the
 *   spec's "propose A, mutate to B, approve A" case, and B must never ship.
 *
 * So the approval row carries a server-owned `ApprovedOperation`: the exact
 * tool name, the exact arguments, the target app, and — for deployment tools —
 * an immutable artifact identity (a digest of the source that was proposed).
 * At execution the candidate is rebuilt from the CURRENT state; a mismatch is
 * `approval_operation_changed` and the owner must re-propose.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ApprovalOperationChangedError,
  captureApprovalOperation,
  functionSourceArtifact,
  readApprovedOperation,
  verifyApprovalOperation,
  workingTreeArtifact,
  type ApprovedOperation,
} from '../approval-operation.js';
import type { WorkingTree } from '../working-tree.js';

function tree(files: Array<{ path: string; content: string }>): WorkingTree {
  const t: WorkingTree = new Map();
  for (const f of files) {
    // Mirrors WorkingTreeCache.write: sha256 over the content.
    t.set(f.path, {
      path: f.path,
      content: f.content,
      sha256: createHash('sha256').update(f.content, 'utf8').digest('hex'),
    });
  }
  return t;
}

describe('captureApprovalOperation', () => {
  it('records version 1, the tool, the exact args and the target app', () => {
    const op = captureApprovalOperation({
      toolName: 'deploy_frontend',
      args: { app_id: 'app_A', note: 'ship it' },
    });

    expect(op).toEqual({
      version: 1,
      toolName: 'deploy_frontend',
      args: { app_id: 'app_A', note: 'ship it' },
      targetAppId: 'app_A',
    });
  });

  it('normalises absent args to null so a JSONB round-trip compares equal', () => {
    expect(captureApprovalOperation({ toolName: 'x', args: undefined }).args).toBeNull();
    expect(captureApprovalOperation({ toolName: 'x', args: null }).args).toBeNull();
  });

  it('carries the artifact identity when one is supplied', () => {
    const op = captureApprovalOperation({
      toolName: 'deploy_frontend',
      args: { app_id: 'app_A' },
      artifact: { kind: 'inline_code', referenceId: 'app_A', sha256: 'a'.repeat(64) },
    });
    expect(op.artifact).toEqual({ kind: 'inline_code', referenceId: 'app_A', sha256: 'a'.repeat(64) });
  });
});

describe('verifyApprovalOperation', () => {
  const approved: ApprovedOperation = {
    version: 1,
    toolName: 'deploy_frontend',
    args: { app_id: 'app_A' },
    targetAppId: 'app_A',
    artifact: { kind: 'inline_code', referenceId: 'app_A', sha256: 'a'.repeat(64) },
  };

  it('accepts an identical operation, regardless of object key order', () => {
    const candidate = captureApprovalOperation({
      toolName: 'deploy_frontend',
      args: { app_id: 'app_A' },
      artifact: { kind: 'inline_code', referenceId: 'app_A', sha256: 'a'.repeat(64) },
    });
    expect(() => verifyApprovalOperation(approved, candidate)).not.toThrow();
  });

  it('rejects a DIFFERENT artifact — the propose-A-approve-B case', () => {
    const candidate = captureApprovalOperation({
      toolName: 'deploy_frontend',
      args: { app_id: 'app_A' },
      artifact: { kind: 'inline_code', referenceId: 'app_A', sha256: 'b'.repeat(64) },
    });
    expect(() => verifyApprovalOperation(approved, candidate)).toThrow(ApprovalOperationChangedError);
  });

  it('rejects changed arguments even when the artifact is absent on both sides', () => {
    const noArtifact: ApprovedOperation = {
      version: 1, toolName: 'insert_row', args: { app_id: 'app_A', table: 't', data: { a: 1 } },
    };
    const candidate = captureApprovalOperation({
      toolName: 'insert_row', args: { app_id: 'app_A', table: 't', data: { a: 2 } },
    });
    expect(() => verifyApprovalOperation(noArtifact, candidate)).toThrow(ApprovalOperationChangedError);
  });

  it('rejects a different tool name', () => {
    const candidate = captureApprovalOperation({ toolName: 'insert_row', args: { app_id: 'app_A' } });
    expect(() => verifyApprovalOperation(approved, candidate)).toThrow(ApprovalOperationChangedError);
  });

  it('rejects a different target app', () => {
    const candidate = captureApprovalOperation({ toolName: 'deploy_frontend', args: { app_id: 'app_B' } });
    expect(() => verifyApprovalOperation(approved, candidate)).toThrow(ApprovalOperationChangedError);
  });

  it('a missing approved operation is not a match (legacy rows need a re-proposal)', () => {
    const candidate = captureApprovalOperation({ toolName: 'deploy_frontend', args: { app_id: 'app_A' } });
    expect(() => verifyApprovalOperation(null, candidate)).toThrow(ApprovalOperationChangedError);
    expect(() => verifyApprovalOperation(undefined, candidate)).toThrow(ApprovalOperationChangedError);
  });

  it('the error carries the stable code the route maps to 409', () => {
    try {
      verifyApprovalOperation(approved, captureApprovalOperation({ toolName: 'x', args: {} }));
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApprovalOperationChangedError);
      expect((err as ApprovalOperationChangedError).code).toBe('approval_operation_changed');
    }
  });
});

describe('artifact identities', () => {
  it('digests a working tree deterministically, independent of insertion order', () => {
    const a = tree([{ path: 'src/a.ts', content: 'A' }, { path: 'src/b.ts', content: 'B' }]);
    const b = tree([{ path: 'src/b.ts', content: 'B' }, { path: 'src/a.ts', content: 'A' }]);

    const artA = workingTreeArtifact('app_A', a);
    const artB = workingTreeArtifact('app_A', b);
    expect(artA).toEqual(artB);
    expect(artA?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artA?.kind).toBe('inline_code');
    expect(artA?.referenceId).toBe('app_A');
  });

  it('changes when any file content changes — B is not A', () => {
    const a = tree([{ path: 'src/a.ts', content: 'A' }]);
    const b = tree([{ path: 'src/a.ts', content: 'B' }]);
    expect(workingTreeArtifact('app_A', a)?.sha256).not.toBe(workingTreeArtifact('app_A', b)?.sha256);
  });

  it('changes when a file is added or removed', () => {
    const one = tree([{ path: 'src/a.ts', content: 'A' }]);
    const two = tree([{ path: 'src/a.ts', content: 'A' }, { path: 'src/b.ts', content: 'B' }]);
    expect(workingTreeArtifact('app_A', one)?.sha256).not.toBe(workingTreeArtifact('app_A', two)?.sha256);
  });

  it('returns undefined for an empty or absent tree, so nothing can be verified', () => {
    expect(workingTreeArtifact('app_A', undefined)).toBeUndefined();
    expect(workingTreeArtifact('app_A', new Map())).toBeUndefined();
  });

  it('digests the function ENTRY file only', () => {
    const t = tree([
      { path: 'functions/send-receipt/index.ts', content: 'export const handler = 1' },
      { path: 'src/unrelated.tsx', content: 'not part of the function' },
    ]);
    const art = functionSourceArtifact('app_A:send-receipt', 'send-receipt', t);
    expect(art?.kind).toBe('inline_code');
    expect(art?.referenceId).toBe('app_A:send-receipt');
    expect(art?.sha256).toMatch(/^[a-f0-9]{64}$/);

    // An unrelated file change must NOT invalidate a function approval.
    const t2 = tree([
      { path: 'functions/send-receipt/index.ts', content: 'export const handler = 1' },
      { path: 'src/unrelated.tsx', content: 'changed' },
    ]);
    expect(functionSourceArtifact('app_A:send-receipt', 'send-receipt', t2)?.sha256).toBe(art?.sha256);

    // The entry file changing must.
    const t3 = tree([{ path: 'functions/send-receipt/index.ts', content: 'export const handler = 2' }]);
    expect(functionSourceArtifact('app_A:send-receipt', 'send-receipt', t3)?.sha256).not.toBe(art?.sha256);
  });

  it('supports .js and .mjs entry files, preferring .ts', () => {
    const js = tree([{ path: 'functions/f/index.js', content: 'x' }]);
    expect(functionSourceArtifact('r', 'f', js)?.sha256).toMatch(/^[a-f0-9]{64}$/);

    const both = tree([
      { path: 'functions/f/index.js', content: 'js' },
      { path: 'functions/f/index.ts', content: 'ts' },
    ]);
    const tsOnly = tree([{ path: 'functions/f/index.ts', content: 'ts' }]);
    expect(functionSourceArtifact('r', 'f', both)?.sha256).toBe(functionSourceArtifact('r', 'f', tsOnly)?.sha256);
  });

  it('returns undefined when the entry file is missing', () => {
    expect(functionSourceArtifact('r', 'f', new Map())).toBeUndefined();
    expect(functionSourceArtifact('r', 'f', tree([{ path: 'functions/other/index.ts', content: 'x' }])))
      .toBeUndefined();
  });
});

describe('readApprovedOperation', () => {
  it('accepts a well-formed stored operation', () => {
    const stored = {
      version: 1,
      toolName: 'deploy_frontend',
      args: { app_id: 'app_A' },
      targetAppId: 'app_A',
      artifact: { kind: 'snapshot', referenceId: 'snap_1', sha256: 'a'.repeat(64) },
    };
    expect(readApprovedOperation(stored)).toEqual(stored);
  });

  it('rejects anything malformed rather than trusting a hand-inserted row', () => {
    expect(readApprovedOperation(null)).toBeNull();
    expect(readApprovedOperation(undefined)).toBeNull();
    expect(readApprovedOperation('string')).toBeNull();
    expect(readApprovedOperation([])).toBeNull();
    expect(readApprovedOperation({})).toBeNull();
    expect(readApprovedOperation({ version: 2, toolName: 'x', args: {} })).toBeNull();
    expect(readApprovedOperation({ version: 1, toolName: 3, args: {} })).toBeNull();
    expect(readApprovedOperation({ version: 1, toolName: 'x' })).toBeNull();
    expect(readApprovedOperation({
      version: 1, toolName: 'x', args: {}, artifact: { kind: 'url', sha256: 'a' },
    })).toBeNull();
    expect(readApprovedOperation({
      version: 1, toolName: 'x', args: {}, artifact: { kind: 'snapshot', sha256: 'not-hex' },
    })).toBeNull();
  });
});
