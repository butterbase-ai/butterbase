import type { FastifyInstance } from 'fastify';
import { fanOutRuntimeRegions } from '../region-resolver.js';
import { getVideoPreparationHooks } from './video-preparation-hooks.js';
import { createVideoPreparationDriver } from './video-preparation.js';
/** Each class has its own capacity/timer, independent of legacy video settlement. */
export function startVideoPreparationWorker(app: FastifyInstance, intervalMs = 5_000): () => void {
 const stops: (() => void)[] = [];
 for (const lane of ['prepare', 'poll', 'settle', 'recover', 'maintenance'] as const) {
  let busy = false;
  const timer = setInterval(async () => {
   const hooks = getVideoPreparationHooks(); if (!hooks || busy) return; busy = true;
   try { await fanOutRuntimeRegions(async (runtimePool, region) => {
    try {
     const context = { runtimePool, platformPool: app.controlDb, region };
     if (lane === 'maintenance') await hooks.maintainReferences?.(context);
     else await createVideoPreparationDriver({ ...context, hooks }).tick(lane);
    }
    catch (error) { if ((error as { code?: string }).code !== '42P01') app.log.warn({ lane, region }, 'video-preparation: lane failed; retry scheduled'); }
   }); } catch { app.log.warn({ lane }, 'video-preparation: region discovery failed'); } finally { busy = false; }
  }, intervalMs);
  timer.unref(); stops.push(() => clearInterval(timer));
 }
 return () => stops.forEach(stop => stop());
}
