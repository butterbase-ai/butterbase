/**
 * credits.ts — Pure functions for KV credit cost mapping.
 *
 * Three pure functions:
 * - classifyRequest: HTTP (method, action, batchOps) → KvOp
 * - creditCostForOp: KvOp → numeric cost
 * - opsCountForOp: KvOp → ops-count for rate-limit purposes
 *
 * No DB, no Redis, no I/O. Safe to call in any context.
 */

/**
 * Classified KV operation kind.
 *
 * Cost table:
 * - read: 1 credit (get, exists, ttl)
 * - write: 2 credits (set, del, expire)
 * - atomic_write: 2 credits (incr, decr, setnx, cas)
 * - mget(N): N credits
 * - mset(N): 2N credits
 */
export type KvOp =
  | { kind: 'read' }
  | { kind: 'write' }
  | { kind: 'atomic_write' }
  | { kind: 'mget'; n: number }
  | { kind: 'mset'; n: number };

/**
 * Compute the credit cost for a classified operation.
 *
 * @param op - The classified KV operation
 * @returns Credit cost (1, 2, N, or 2N depending on op kind)
 */
export function creditCostForOp(_op: KvOp): number {
  // KV operations are not metered against credits.
  return 0;
}

/**
 * Compute the ops-count for rate-limit purposes.
 *
 * Single ops count as 1; batch ops count as their batch size N.
 *
 * @param op - The classified KV operation
 * @returns Ops count (1 or N)
 */
export function opsCountForOp(op: KvOp): number {
  switch (op.kind) {
    case 'read':
    case 'write':
    case 'atomic_write':
      return 1;
    case 'mget':
    case 'mset':
      return op.n;
  }
}

/**
 * Classify a request (HTTP method, parsed action, batch ops) into a KvOp.
 *
 * Rules:
 * - If action is present, classify by action name
 * - If action is null, classify by HTTP method
 * - If batchOps is present and non-empty, classify as mget (all get) or mset (mixed/all write)
 * - Otherwise return null (unknown/invalid request)
 *
 * @param method - HTTP method (GET, PUT, DELETE, POST)
 * @param action - Parsed action suffix from URL (ttl, exists, incr, decr, setnx, cas, expire) or null
 * @param batchOps - Array of batch operations with shape { op: string; ... } (optional)
 * @returns Classified KvOp, or null if unrecognized
 */
export function classifyRequest(
  method: string,
  action: string | null,
  batchOps?: { op: string }[],
): KvOp | null {
  // Action-based classification (highest precedence)
  if (action) {
    if (action === 'ttl' || action === 'exists') return { kind: 'read' };
    if (action === 'incr' || action === 'decr' || action === 'setnx' || action === 'cas') {
      return { kind: 'atomic_write' };
    }
    if (action === 'expire') return { kind: 'write' };
    return null;
  }

  // HTTP method-based classification
  if (method === 'GET') return { kind: 'read' };
  if (method === 'PUT') return { kind: 'write' };
  if (method === 'DELETE') return { kind: 'write' };

  // Batch operations classification
  if (batchOps?.length) {
    const isAllGet = batchOps.every((o) => o.op === 'get');
    if (isAllGet) return { kind: 'mget', n: batchOps.length };
    return { kind: 'mset', n: batchOps.length }; // conservative: treat mixed as write
  }

  return null;
}
