import type { StepHandler } from './saga-executor.js';

export interface FlipCtx {
  writeSubdomainMapping?: (subdomain: string, appId: string, region: string) => Promise<void>;
  writeDomainMapping?: (hostname: string, appId: string, region: string) => Promise<void>;
  listCustomDomains?: (region: string, appId: string) => Promise<Array<{ hostname: string }>>;
  invalidateCacheAllRegions?: (appId: string) => Promise<void>;
  updateUserAppIndexRegion?: (controlPool: any, appId: string, region: string) => Promise<void>;
}

export const executeFlipRouting: StepHandler = async (ctx, m) => {
  const cx = ctx as unknown as FlipCtx & typeof ctx;

  const destPool = ctx.runtimePoolFor(m.dest_region);

  // (1) Confirm dest apps.region is correct
  await destPool.query(`UPDATE apps SET region = $1 WHERE id = $2`, [m.dest_region, m.app_id]);

  // (2) Update platform DB user_app_index
  if (!cx.updateUserAppIndexRegion) throw new Error('updateUserAppIndexRegion not injected');
  await cx.updateUserAppIndexRegion(ctx.controlPool, m.app_id, m.dest_region);

  // (3) Update Cloudflare KV
  const subRes = await destPool.query<{ subdomain: string }>(
    `SELECT subdomain FROM apps WHERE id = $1`, [m.app_id],
  );
  const subdomain = subRes.rows[0]?.subdomain;
  if (subdomain && cx.writeSubdomainMapping) {
    await cx.writeSubdomainMapping(subdomain, m.app_id, m.dest_region);
  }
  if (cx.listCustomDomains && cx.writeDomainMapping) {
    const domains = await cx.listCustomDomains(m.dest_region, m.app_id);
    for (const d of domains) {
      await cx.writeDomainMapping(d.hostname, m.app_id, m.dest_region);
    }
  }

  // (4) Invalidate region-resolver cache in every region's Redis
  if (cx.invalidateCacheAllRegions) {
    await cx.invalidateCacheAllRegions(m.app_id);
  }

  // (5) Mark dest as ready AND db_provisioned. Without db_provisioned=true,
  // the v1/:app_id preHandler returns APP_PROVISIONING 409 — reserve-dest
  // inserted the row with the column defaulting to false.
  await destPool.query(
    `UPDATE apps SET provisioning_status = 'ready', db_provisioned = true WHERE id = $1`, [m.app_id],
  );

  return {
    next: 'setting_up_reverse_replication',
    patch: { flipped_at: new Date().toISOString() },
  };
};
