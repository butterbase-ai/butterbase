/**
 * Shared deploy-tree snapshots.
 *
 * THE FAILURE THIS CLOSES. An operator proposes `deploy_frontend` on one API
 * machine; the approval row records a digest of the working tree but not the
 * files. Fly routes the later resolve to a different machine, whose
 * `WorkingTreeCache` is a process-local `Map` that has never seen this
 * conversation. The approved operation is real and the digest matches nothing,
 * because there is nothing to compare it to — the deploy then fails with
 * "no files to deploy" (or an approval left pending forever).
 *
 * The design spec allows inline source plus a digest; the implementation
 * persisted only the digest. This store persists the exact proposed tree under
 * the approval id, in Redis, so ANY instance can rehydrate it at execution.
 *
 * WHY REDIS AND NOT THE DATABASE. The tree can be hundreds of kilobytes of
 * source. It is short-lived (an approval is normally resolved within a day),
 * it is read once by one machine at execution, and it needs no transaction
 * with the approval row. Redis with a TTL is the right lifetime; the approval
 * row keeps only the digest, so lists and feeds never carry source.
 *
 * FAIL-CLOSED BOUNDARY. A missing or expired snapshot is NOT a reason to fall
 * back to whatever the live cache happens to hold. The caller must refuse the
 * execution and require a re-proposal (`deploy_tree_unavailable`); a live tree
 * that merely looks similar is not proof that it is the approved artifact.
 */
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { getRedisClient } from '../redis.js';
import type { WorkingFile, WorkingTree } from './working-tree.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const DEPLOY_TREE_KEY_PREFIX = 'office:deploy-tree:';
export const DEPLOY_TREE_TTL_SECONDS = 24 * 60 * 60;

/**
 * The subset of ioredis this module uses. Injectable so unit tests can use an
 * in-memory map instead of requiring a live Redis.
 */
export type DeployTreeRedis = {
  set(key: string, value: Buffer | string, mode: 'EX', ttl: number): Promise<unknown>;
  getBuffer(key: string): Promise<Buffer | null>;
};

export type DeployTreeStore = {
  /**
   * Persist `tree` under `approvalId`. Returns false when there is nothing to
   * save (missing/empty tree) or the write failed — the caller must then fail
   * closed rather than create an approval that can never execute.
   */
  save(approvalId: string, tree: WorkingTree | undefined): Promise<boolean>;
  /**
   * Rehydrate the tree, or null when it is missing, expired, or unreadable.
   * Never throws: a Redis outage is the same fail-closed answer as an expiry.
   */
  load(approvalId: string): Promise<WorkingTree | null>;
};

type SerializedTree = {
  version: 1;
  files: Array<{ path: string; content: string }>;
};

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function keyFor(approvalId: string): string {
  return `${DEPLOY_TREE_KEY_PREFIX}${approvalId}`;
}

function isSerializedTree(value: unknown): value is SerializedTree {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !Array.isArray(row.files)) return false;
  return row.files.every((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return false;
    const entry = file as Record<string, unknown>;
    return typeof entry.path === 'string' && typeof entry.content === 'string';
  });
}

export function createDeployTreeStore(
  deps: { redis?: DeployTreeRedis; ttlSeconds?: number } = {},
): DeployTreeStore {
  // Resolved lazily: constructing the store must not open a Redis connection
  // in every process (or every unit test) that merely imports the loop.
  const redis = (): DeployTreeRedis => deps.redis ?? (getRedisClient() as unknown as DeployTreeRedis);
  const ttlSeconds = deps.ttlSeconds ?? DEPLOY_TREE_TTL_SECONDS;

  return {
    async save(approvalId, tree) {
      if (!tree || tree.size === 0) return false;
      const files = Array.from(tree.values()).map((f) => ({ path: f.path, content: f.content }));
      const payload: SerializedTree = { version: 1, files };
      try {
        const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload), 'utf8'));
        await redis().set(keyFor(approvalId), compressed, 'EX', ttlSeconds);
        return true;
      } catch (err) {
        console.error(
          `[deploy-tree-store] failed to save snapshot for approval ${approvalId}:`,
          err instanceof Error ? err.message : err,
        );
        return false;
      }
    },

    async load(approvalId) {
      try {
        const raw = await redis().getBuffer(keyFor(approvalId));
        if (!raw) return null;
        const parsed: unknown = JSON.parse((await gunzipAsync(raw)).toString('utf8'));
        if (!isSerializedTree(parsed)) return null;
        const tree: WorkingTree = new Map();
        for (const file of parsed.files) {
          // Recompute rather than trusting a stored digest: the digest is the
          // proof the approved artifact is the executed one.
          const entry: WorkingFile = { path: file.path, content: file.content, sha256: sha(file.content) };
          tree.set(file.path, entry);
        }
        return tree;
      } catch {
        // Corrupt payload, decompression failure, Redis down — all are "no
        // snapshot", which the caller turns into a re-proposal.
        return null;
      }
    },
  };
}

let _shared: DeployTreeStore | undefined;

/** One store per process; the Redis client itself is shared and lazy. */
export function getSharedDeployTreeStore(): DeployTreeStore {
  if (!_shared) _shared = createDeployTreeStore();
  return _shared;
}
