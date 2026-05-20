import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { config, assertRuntimeDbConfig } from '../config.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Returns the runtime DB pool for the given Butterbase region.
     * Throws if the region is unknown or its URL isn't configured.
     */
    runtimeDb: (region: string) => pg.Pool;
    /**
     * Resolves the app's home region (via user_app_index, Redis-cached) and
     * returns the runtime DB pool for that region. Use this for every per-app
     * query instead of computing the region from the local machine — apps may
     * live in any configured region regardless of which machine handles the
     * request.
     */
    runtimeDbForApp: (appId: string) => Promise<pg.Pool>;
  }
}

async function runtimeDatabasePlugin(fastify: FastifyInstance) {
  assertRuntimeDbConfig();
  fastify.decorate('runtimeDb', (region: string) => {
    return getRuntimeDbPool(config.runtimeDb, region);
  });
  fastify.decorate('runtimeDbForApp', (appId: string) => {
    return getRuntimeDbForApp(fastify.controlDb, appId);
  });
}

export default fp(runtimeDatabasePlugin, {
  name: 'runtime-database',
});
