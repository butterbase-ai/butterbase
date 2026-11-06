/**
 * Immutable approval operations.
 *
 * An approval is a human authorising ONE operation with ONE set of arguments
 * against ONE artifact. It is not a standing permission and it is not
 * "whatever the workspace contains when the click lands".
 *
 * WHY A DIGEST AND NOT A URL. The spec is explicit: persist a storage
 * `objectId`, an immutable snapshot id, or inline source plus a digest — never
 * an expiring presigned URL and never a bucket `objectKey` (the key is not a
 * URL, and the URL expires). The same rule as file storage generally: the
 * stable reference is the id/digest; URLs are resolved at use time.
 *
 * WHY THE OPERATION LIVES IN THE DATABASE, NOT THE TOOL ARGUMENTS. Downstream
 * tools receive only their original arguments. Everything the server needs to
 * prove the call still matches what was approved — the app it targeted, the
 * digest of the source that was proposed — travels in the server-owned
 * `dashboard_agent_approvals.approved_operation` column. A resolve request
 * cannot supply it, override it, or add to it: the route parses only a status
 * and an optional deny reason.
 *
 * THE THREAT THIS CLOSES. Propose artifact A → the working tree changes to B
 * (another wake, a retry, a fix) → the owner approves A. A naive replay reads
 * the CURRENT tree and ships B. `verifyApprovalOperation` compares the recorded
 * identity against a candidate rebuilt from the current state and refuses on
 * any difference with `approval_operation_changed`. B is never substituted,
 * and a retried approve of the same frozen operation still hits `executeOnce`'s
 * per-approval cache rather than mutating twice.
 */
import { createHash } from 'node:crypto';
import type { WorkingTree } from './working-tree.js';

/** Where an artifact lives, and how to prove it is still the same one. */
export type ApprovalArtifact = {
  /**
   * `storage_object` — an uploaded object, identified by its objectId.
   * `snapshot`       — an immutable repo snapshot id.
   * `inline_code`    — source proposed in the working tree; the digest is
   *                    over the exact bytes that were present at proposal.
   */
  kind: 'storage_object' | 'snapshot' | 'inline_code';
  /** objectId / snapshot id / app (and function) identity. Opaque to this module. */
  referenceId?: string;
  /** sha256 hex over the artifact's canonical bytes. */
  sha256: string;
};

export type ApprovedOperation = {
  version: 1;
  toolName: string;
  args: unknown;
  /** `args.app_id` when the call names one. Compared like every other field. */
  targetAppId?: string;
  artifact?: ApprovalArtifact;
};

/**
 * Thrown when the operation a human approved is not the operation the server
 * is now able to execute. Carries the stable code the HTTP layer maps to 409.
 */
export class ApprovalOperationChangedError extends Error {
  readonly code = 'approval_operation_changed';

  constructor(message = 'approval_operation_changed: the approved operation no longer matches') {
    super(message);
    this.name = 'ApprovalOperationChangedError';
  }
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Recursively sort object keys so two JSONB round-trips compare equal.
 * Arrays keep their order — argument order is part of the operation.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

/**
 * Build the server-owned record of what is being approved.
 *
 * `args` is normalised to `null` when absent so a Postgres JSONB round-trip
 * (which stores SQL NULL for an undefined) compares equal to the in-memory
 * capture. The object is otherwise stored verbatim — the loop passes the
 * model's own parsed arguments.
 */
export function captureApprovalOperation(input: {
  toolName: string;
  args: unknown;
  artifact?: ApprovalArtifact;
}): ApprovedOperation {
  const args = input.args === undefined ? null : input.args;
  const appId =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>).app_id
      : undefined;

  const op: ApprovedOperation = {
    version: 1,
    toolName: input.toolName,
    args,
  };
  if (typeof appId === 'string' && appId.length > 0) op.targetAppId = appId;
  if (input.artifact) op.artifact = input.artifact;
  return op;
}

/**
 * Prove the candidate operation is exactly the recorded one. Throws
 * `ApprovalOperationChangedError` on ANY difference, including a missing
 * recorded operation (a legacy Office approval that never had sufficient
 * immutable metadata — the spec requires those to be re-proposed).
 */
export function verifyApprovalOperation(
  approval: ApprovedOperation | null | undefined,
  candidate: ApprovedOperation,
): void {
  if (!approval) {
    throw new ApprovalOperationChangedError(
      'approval_operation_changed: this approval has no recorded operation and must be re-proposed',
    );
  }

  const fields: Array<keyof ApprovedOperation> = ['version', 'toolName', 'args', 'targetAppId', 'artifact'];
  for (const field of fields) {
    if (canonicalJson(approval[field]) !== canonicalJson(candidate[field])) {
      throw new ApprovalOperationChangedError(
        `approval_operation_changed: ${String(field)} differs from the approved operation`,
      );
    }
  }
}

/**
 * Parse a stored JSONB value defensively. A hand-inserted or corrupted row is
 * not evidence of an approval — treat it as "no operation recorded", which the
 * Office path turns into a re-proposal requirement rather than an execution.
 */
export function readApprovedOperation(value: unknown): ApprovedOperation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;

  if (row.version !== 1) return null;
  if (typeof row.toolName !== 'string' || row.toolName.length === 0) return null;
  if (!('args' in row)) return null;
  if (row.targetAppId !== undefined && typeof row.targetAppId !== 'string') return null;

  let artifact: ApprovalArtifact | undefined;
  if (row.artifact !== undefined) {
    if (!row.artifact || typeof row.artifact !== 'object' || Array.isArray(row.artifact)) return null;
    const a = row.artifact as Record<string, unknown>;
    if (a.kind !== 'storage_object' && a.kind !== 'snapshot' && a.kind !== 'inline_code') return null;
    if (typeof a.sha256 !== 'string' || !SHA256_HEX.test(a.sha256)) return null;
    if (a.referenceId !== undefined && typeof a.referenceId !== 'string') return null;
    artifact = {
      kind: a.kind,
      sha256: a.sha256,
      ...(typeof a.referenceId === 'string' ? { referenceId: a.referenceId } : {}),
    };
  }

  const op: ApprovedOperation = {
    version: 1,
    toolName: row.toolName,
    args: row.args,
  };
  if (typeof row.targetAppId === 'string') op.targetAppId = row.targetAppId;
  if (artifact) op.artifact = artifact;
  return op;
}

/**
 * Digest of a whole working tree: `path \0 sha256` per file, sorted, then
 * hashed. Path AND content are both included, so an add, a remove, a rename
 * and a content edit are all different artifacts.
 *
 * Returns undefined for a missing or empty tree. Undefined is NOT "equal to
 * nothing approved" — the caller's candidate then has no artifact, which can
 * never match a recorded one, so verification fails closed.
 */
export function workingTreeArtifact(
  referenceId: string,
  tree: WorkingTree | undefined,
): ApprovalArtifact | undefined {
  if (!tree || tree.size === 0) return undefined;
  const lines = Array.from(tree.values())
    .map((f) => `${f.path}\u0000${f.sha256}`)
    .sort();
  return {
    kind: 'inline_code',
    referenceId,
    sha256: sha256(lines.join('\n')),
  };
}

/**
 * Digest of a function's single entry file — the exact bytes
 * `deploy-function.ts` sends to the runtime. Deliberately NOT the whole tree:
 * an unrelated frontend edit must not invalidate a function approval.
 */
const FUNCTION_ENTRY_CANDIDATES = ['index.ts', 'index.js', 'index.mjs'];

export function functionSourceArtifact(
  referenceId: string,
  functionName: string,
  tree: WorkingTree | undefined,
): ApprovalArtifact | undefined {
  if (!tree) return undefined;
  for (const candidate of FUNCTION_ENTRY_CANDIDATES) {
    const file = tree.get(`functions/${functionName}/${candidate}`);
    if (file) {
      return { kind: 'inline_code', referenceId, sha256: file.sha256 };
    }
  }
  return undefined;
}

/**
 * The artifact for a deployment tool, from the turn's working tree.
 *
 * Exported so the loop (proposal time) and the approval executor (execution
 * time) compute it from the SAME definition. If these ever diverge, every
 * deploy approval would fail verification, which is safe but useless — and if
 * they diverged in the other direction (one of them skipped the digest) the
 * propose-A-approve-B hole would reopen. One function, two call sites.
 *
 * Returns undefined for tools that carry no build artifact and for a missing
 * app id / tree; verification then refuses rather than guessing.
 */
export function deploymentArtifact(
  toolName: string,
  args: unknown,
  tree: WorkingTree | undefined,
): ApprovalArtifact | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const a = args as Record<string, unknown>;
  const appId = typeof a.app_id === 'string' && a.app_id.length > 0 ? a.app_id : null;
  if (!appId) return undefined;

  if (toolName === 'deploy_frontend') return workingTreeArtifact(appId, tree);

  if (toolName === 'deploy_function_from_workspace') {
    const functionName = typeof a.function_name === 'string' ? a.function_name : null;
    if (!functionName) return undefined;
    return functionSourceArtifact(`${appId}:${functionName}`, functionName, tree);
  }

  return undefined;
}
