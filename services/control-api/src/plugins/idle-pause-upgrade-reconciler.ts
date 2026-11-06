import fp from 'fastify-plugin';
import { startIdlePauseUpgradeReconciler } from '../services/idle-pause-upgrade-reconciler.js';

export default fp(async app => {
  let stop: (() => Promise<void>) | undefined;
  app.addHook('onReady', async () => { stop = startIdlePauseUpgradeReconciler(app.controlDb, app.log); });
  app.addHook('onClose', async () => { await stop?.(); });
}, { name: 'idle-pause-upgrade-reconciler' });
