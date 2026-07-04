import { describe, it, expect, vi } from 'vitest';
import { executeFlipRouting } from './step-flip-routing.js';

describe('executeFlipRouting', () => {
  it('updates apps.region, index, KV, invalidates cache, marks dest ready', async () => {
    const sourcePool = { query: vi.fn() };
    const destPool = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('subdomain')) return { rows: [{ subdomain: 'demo' }] };
        return { rows: [] };
      }),
    };
    const platform = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const writeSubdomainMapping = vi.fn().mockResolvedValue(undefined);
    const writeDomainMapping = vi.fn().mockResolvedValue(undefined);
    const listCustomDomains = vi.fn().mockResolvedValue([{ hostname: 'a.example.com' }]);
    const invalidateCacheAllRegions = vi.fn().mockResolvedValue(undefined);
    const updateOrgAppIndexRegion = vi.fn().mockResolvedValue(undefined);

    const ctx: any = {
      controlPool: platform,
      runtimePoolFor: (r: string) => (r === 'us-east-1' ? sourcePool : destPool),
      redisFor: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      writeSubdomainMapping, writeDomainMapping, listCustomDomains, invalidateCacheAllRegions, updateOrgAppIndexRegion,
    };
    const m: any = { id: 'mig-1', app_id: 'app-x', source_region: 'us-east-1', dest_region: 'eu-west-1', current_step: 'flipping_routing', dest_resources: {} };
    const res = await executeFlipRouting(ctx, m);
    expect(res.next).toBe('setting_up_reverse_replication');
    expect(updateOrgAppIndexRegion).toHaveBeenCalledWith(platform, 'app-x', 'eu-west-1');
    expect(writeSubdomainMapping).toHaveBeenCalledWith('demo', 'app-x', 'eu-west-1');
    expect(writeDomainMapping).toHaveBeenCalledWith('a.example.com', 'app-x', 'eu-west-1');
    expect(invalidateCacheAllRegions).toHaveBeenCalledWith('app-x');
  });
});
