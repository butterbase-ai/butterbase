import type { StepHandler } from './saga-executor.js';

export interface CopyBlobsCtx {
  copyObject?: (args: { sourceRegion: string; destRegion: string; key: string }) => Promise<void>;
}

export const executeCopyBlobs: StepHandler = async (ctx, m) => {
  if ((process.env.STORAGE_PROVIDER ?? 'r2') === 'r2') {
    return { next: 'copying_runtime', patch: { blobs_skipped: true } };
  }
  const cx = ctx as unknown as CopyBlobsCtx & typeof ctx;
  if (!cx.copyObject) throw new Error('copyObject not injected and STORAGE_PROVIDER=s3');

  const sourcePool = ctx.runtimePoolFor(m.source_region);
  const { rows } = await sourcePool.query<{ object_key: string }>(
    `SELECT object_key FROM storage_objects WHERE app_id = $1 AND archived_after_move IS NULL`,
    [m.app_id],
  );

  let n = 0;
  for (const row of rows) {
    await cx.copyObject({ sourceRegion: m.source_region, destRegion: m.dest_region, key: row.object_key });
    n++;
    if (n % 100 === 0) ctx.log.info({ migrationId: m.id, copied: n, total: rows.length }, 'blobs copied');
  }
  return { next: 'copying_runtime', patch: { blobs_copied: n } };
};
