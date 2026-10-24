import fp from 'fastify-plugin';
import { idlePauseConfigFromEnv } from '../services/idle-pause-config.js';
import { startIdlePauseReaper } from '../services/idle-app-reaper.js';
import { getRedisClient } from '../services/redis.js';

// All replicas must share REDIS_URL, as for lock:nightly-billing.
export default fp(async (app) => {
  let stop: (() => Promise<void>) | undefined;
  app.addHook('onReady', async () => {
    if (!idlePauseConfigFromEnv() || process.env.SKIP_IDLE_PAUSE_REAPER) return;
    stop = startIdlePauseReaper({
      controlDb: app.controlDb,
      runtimeDb: (region) => app.runtimeDb(region),
      redis: getRedisClient(),
      log: app.log,
    });
  });
  app.addHook('onClose', async () => { await stop?.(); });
}, { name: 'idle-pause-reaper' });
