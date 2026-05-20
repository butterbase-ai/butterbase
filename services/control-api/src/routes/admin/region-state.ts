import type { FastifyPluginAsync } from 'fastify';

const regionStateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/internal/region-state', async () => {
    const configuredRegions = (process.env.BUTTERBASE_REGIONS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);

    const r = await fastify.controlDb.query<{ region: string; c: number }>(
      `SELECT region, count(*)::int AS c
       FROM user_app_index
       GROUP BY region`
    );
    const appCountByRegion: Record<string, number> = {};
    for (const region of configuredRegions) appCountByRegion[region] = 0;
    for (const row of r.rows) appCountByRegion[row.region] = row.c;

    const unknownRegions = r.rows
      .filter((x) => !configuredRegions.includes(x.region))
      .map((x) => ({ region: x.region, appCount: x.c }));

    return {
      platformRegion: process.env.BUTTERBASE_PLATFORM_REGION ?? null,
      localRegion: process.env.BUTTERBASE_REGION ?? null,
      configuredRegions,
      appCountByRegion,
      unknownRegions,
    };
  });
};

export default regionStateRoutes;
