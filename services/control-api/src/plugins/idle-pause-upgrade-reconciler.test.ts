import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
const stop=vi.hoisted(()=>vi.fn(async()=>{}));
const start=vi.hoisted(()=>vi.fn());
vi.mock('../services/idle-pause-upgrade-reconciler.js',()=>({startIdlePauseUpgradeReconciler:start}));
import plugin from './idle-pause-upgrade-reconciler.js';
it('registers recovery at startup and drains it before database shutdown',async()=>{
  let closed=false;start.mockReturnValue(stop);stop.mockImplementation(async()=>{expect(closed).toBe(false);});
  const app=Fastify();app.decorate('controlDb',{} as never);
  app.addHook('onClose',async()=>{closed=true;});
  await app.register(plugin);await app.ready();
  expect(start).toHaveBeenCalledWith(app.controlDb,app.log);
  await app.close();expect(stop).toHaveBeenCalledOnce();expect(closed).toBe(true);
});
