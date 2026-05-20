import type { FastifyPluginAsync } from 'fastify';
import { assertRegionConfig } from '../config.js';

const regionsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/regions', {
    config: { public: true },
  }, async () => {
    const { regions } = assertRegionConfig();
    return { regions };
  });
};

export default regionsRoutes;
