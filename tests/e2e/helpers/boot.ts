import pg from 'pg';
import { Redis } from 'ioredis';
import { config as loadEnv } from 'dotenv';
import { buildApp } from '../../../services/control-api/src/index.js';
import { runtimePoolFor, listRuntimeRegions, shutdownAllRuntimePools } from '../../../services/control-api/src/services/runtime-pool-registry.js';
import { redisFor, shutdownAllRedisClients } from '../../../services/control-api/src/services/redis-registry.js';

loadEnv({ path: '.env.e2e' });

export interface BootOpts {
  withDriver?: boolean;
}

export interface E2EEnv {
  controlPool: pg.Pool;
  redis: Redis;
  regions: string[];
  app: Awaited<ReturnType<typeof buildApp>>;
  shutdown: () => Promise<void>;
}

export async function bootE2E(opts: BootOpts = {}): Promise<E2EEnv> {
  const controlPool = new pg.Pool({ connectionString: process.env.NEON_PLATFORM_PRIMARY_URL! });
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const app = await buildApp();
  await app.ready();
  const regions = listRuntimeRegions();

  let driverStop: (() => void) | null = null;
  if (opts.withDriver) {
    // Lazy import to avoid loading the driver/cron module unless requested.
    const { startMoveAppDriver } = await import('../../../services/cron-scheduler/src/move-app-driver.js');
    const { stepHandlers } = await import('../../../services/control-api/src/services/move-app/step-registry.js');
    // The cron-scheduler builds its own sagaCtx. For E2E we reuse the same
    // injectors that control-api put on app.moveAppCtx (they're production-shaped now).
    const ctx: any = (app as any).moveAppCtx;
    if (!ctx) throw new Error('app.moveAppCtx not decorated; cannot start driver');
    const driver = startMoveAppDriver({ ctx, redis, handlers: stepHandlers, intervalMs: 500 });
    driverStop = () => driver.stop();
  }

  const shutdown = async () => {
    if (driverStop) driverStop();
    await app.close();
    await controlPool.end();
    await redis.quit();
    await shutdownAllRuntimePools();
    await shutdownAllRedisClients();
  };

  return { controlPool, redis, regions, app, shutdown };
}

// Suppress unused-import warnings for re-exported runtime utilities.
export { runtimePoolFor, redisFor };
