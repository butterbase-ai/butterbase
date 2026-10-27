import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import * as outputs from './video-preparation-outputs.js';
import { spoolVideoOutput } from './video-output-spool.js';
import { createRetainedVideoStore, VideoOutputStorageError, type RetainedVideoObject } from './video-output-store.js';
import { StorageAdmissionError } from '../storage-admission.js';

export function retainedVideoIdentity(row: outputs.PreparedOutputRow): RetainedVideoObject {
  if (!row.sha256 || !row.content_type || !row.size_bytes) throw new VideoOutputStorageError('OUTPUT_INVALID_MEDIA', true);
  return { appId: row.app_id, organizationId: row.organization_id, ownerId: row.user_id, attemptId: row.attempt_id,
    objectId: row.object_id, index: row.output_index, bucket: row.bucket, key: row.object_key,
    sizeBytes: Number(row.size_bytes), sha256: row.sha256, contentType: row.content_type };
}
export type OutputMaterializationResult =
  | { status: 'ready'; outputObjectIds: string[]; providerCostUsd?: number }
  | { status: 'pending'; refreshSources?: boolean }
  | { status: 'failed'; error: string; providerCostUsd?: number };

/** One bounded copy per invocation. Caller already owns an accepted attempt lease. */
type MaterializationOptions = {
  pool: pg.Pool; attemptId: string; attemptFence: number;
  authorize(row: outputs.PreparedOutputRow, additionalBytes: number): Promise<void>;
  fetchSource(handle: string, signal: AbortSignal): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }>;
  createStore?: (signal: AbortSignal) => ReturnType<typeof createRetainedVideoStore>;
  timeoutMs?: number;
};
// A database lease can expire while a database or policy call is still running.
// Keep the local slot until that invocation and its file disposal actually end.
const activeCopies = new WeakMap<pg.Pool, number>();
export async function materializePreparedVideoOutputs(options: MaterializationOptions): Promise<OutputMaterializationResult> {
  const active = activeCopies.get(options.pool) ?? 0;
  if (active >= 2) return { status: 'pending' };
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid copy timeout');
  activeCopies.set(options.pool, active + 1);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<OutputMaterializationResult>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve({ status: 'pending' }); }, timeoutMs); timer.unref();
  });
  const work = materialize(options, controller.signal).finally(() => {
    clearTimeout(timer); controller.abort();
    activeCopies.set(options.pool, (activeCopies.get(options.pool) ?? 1) - 1);
  });
  return Promise.race([work, expired]);
}
async function materialize(options: MaterializationOptions, signal: AbortSignal): Promise<OutputMaterializationResult> {
  const { pool, attemptId, attemptFence } = options;
  const rows = await outputs.listPreparedOutputs(pool, attemptId);
  if (signal.aborted) return { status: 'pending' };
  if (!rows.length) return { status: 'pending', refreshSources: true };
  const evidence = rows[0].provider_cost_usd === null ? {} : { providerCostUsd: Number(rows[0].provider_cost_usd) };
  const failed = rows.find(row => row.deleted_at || ['cleanup_pending','deleted','failed'].includes(row.state));
  if (failed) return { status: 'failed', error: failed.error_code ?? 'output_delivery_failed', ...evidence };
  const finish = async (): Promise<OutputMaterializationResult> => {
    const ids = await outputs.commitPreparedOutputMetadata(pool, { attemptId, attemptFence });
    return ids ? { status: 'ready', outputObjectIds: ids, ...evidence } : { status: 'pending' };
  };
  const next = rows.find(row => ['pending','copying'].includes(row.state));
  if (!next) return finish();
  const row = await outputs.claimPreparedOutput(pool, next.id, { attemptFence, worker: randomUUID(), leaseMs: 35_000 });
  if (!row) return { status: 'pending' };
  const store = options.createStore?.(signal) ?? createRetainedVideoStore({ signal });
  let spooled: Awaited<ReturnType<typeof spoolVideoOutput>> | undefined, sourceFailure = false;
  try {
    signal.throwIfAborted();
    await options.authorize(row, row.capacity_reserved ? 0 : Number(row.size_bytes ?? 0));
    signal.throwIfAborted();
    if (row.sha256 && await store.inspect(retainedVideoIdentity(row))) {
      if (!await outputs.markPreparedOutputCopied(pool, row.id, row.fence)) return { status: 'pending' };
      return finish();
    }
    if (!row.source_handle) {
      await outputs.deferPreparedOutput(pool, row.id, row.fence, 'output_source_refresh', new Date(Date.now() + 5000), true);
      return { status: 'pending', refreshSources: true };
    }
    sourceFailure = true;
    spooled = await spoolVideoOutput(await options.fetchSource(row.source_handle, signal), { maxBytes: outputs.PREPARED_OUTPUT_MAX_BYTES, signal });
    sourceFailure = false;
    if (row.sha256 && (row.sha256 !== spooled.sha256 || Number(row.size_bytes) !== spooled.sizeBytes || row.content_type !== spooled.contentType)) {
      throw new VideoOutputStorageError('OUTPUT_MEDIA_CHANGED', true);
    }
    if (!await outputs.recordPreparedOutputMeasurement(pool, row.id, row.fence, spooled)) return { status: 'pending' };
    const measured = { ...row, sha256: spooled.sha256, size_bytes: String(spooled.sizeBytes), content_type: spooled.contentType };
    await options.authorize(measured, row.capacity_reserved ? 0 : spooled.sizeBytes);
    signal.throwIfAborted();
    if (!await outputs.reservePreparedOutputCapacity(pool, row.id, row.fence)) return { status: 'pending' };
    signal.throwIfAborted();
    if (!await outputs.markPreparedOutputUploadStarted(pool, row.id, row.fence)) return { status: 'pending' };
    await store.putFile(retainedVideoIdentity(measured), spooled.filePath);
    if (!await outputs.markPreparedOutputCopied(pool, row.id, row.fence)) {
      await outputs.rearmLatePreparedOutputCleanup(pool, row.id); return { status: 'pending' };
    }
    return finish();
  } catch (error) {
    const permanent = (error instanceof VideoOutputStorageError || error instanceof StorageAdmissionError) && error.permanent;
    const code = (error instanceof VideoOutputStorageError || error instanceof StorageAdmissionError) ? error.code.toLowerCase() : 'output_storage_transient';
    if (permanent) {
      await outputs.requestPreparedOutputCleanup(pool, { attemptId, attemptFence, errorCode: code });
      return { status: 'failed', error: code, ...evidence };
    }
    await outputs.deferPreparedOutput(pool, row.id, row.fence, code, new Date(Date.now() + 5000), sourceFailure);
    return { status: 'pending', ...(sourceFailure ? { refreshSources: true } : {}) };
  } finally { await spooled?.dispose(); }
}
