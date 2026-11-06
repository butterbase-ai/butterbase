import type { StepHandler } from './saga-executor.js';
import { cutoverAppState } from './cutover-app-state.js';

export interface FlipCtx {
  writeSubdomainMapping?: (subdomain: string, appId: string, region: string, paused?: boolean) => Promise<void>;
  writeDomainMapping?: (hostname: string, appId: string, region: string, paused?: boolean) => Promise<void>;
  listCustomDomains?: (region: string, appId: string) => Promise<Array<{ hostname: string }>>;
  invalidateCacheAllRegions?: (appId: string) => Promise<void>;
  updateOrgAppIndexRegion?: (controlPool: any, appId: string, region: string) => Promise<void>;
}

export const executeFlipRouting: StepHandler = async (ctx, m) => {
  const cx = ctx as unknown as FlipCtx & typeof ctx;

  const destPool = ctx.runtimePoolFor(m.dest_region);

  await cutoverAppState(ctx, m.app_id, m.source_region, m.dest_region);
  if (cx.invalidateCacheAllRegions) await cx.invalidateCacheAllRegions(m.app_id);

  // (3) Update Cloudflare KV
  const subRes = await destPool.query<{ subdomain: string; paused: boolean }>(
    `SELECT subdomain, paused FROM apps WHERE id = $1`, [m.app_id],
  );
  const subdomain = subRes.rows[0]?.subdomain;
  const paused = subRes.rows[0]?.paused === true;
  if (subdomain && cx.writeSubdomainMapping) {
    await cx.writeSubdomainMapping(subdomain, m.app_id, m.dest_region, paused);
  }
  if (cx.listCustomDomains && cx.writeDomainMapping) {
    const domains = await cx.listCustomDomains(m.dest_region, m.app_id);
    for (const d of domains) {
      await cx.writeDomainMapping(d.hostname, m.app_id, m.dest_region, paused);
    }
  }

  // (4) Invalidate region-resolver cache in every region's Redis
  if (cx.invalidateCacheAllRegions) {
    await cx.invalidateCacheAllRegions(m.app_id);
  }

  return {
    next: 'setting_up_reverse_replication',
    patch: { flipped_at: new Date().toISOString() },
  };
};
