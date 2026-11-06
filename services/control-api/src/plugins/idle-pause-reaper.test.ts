import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const start = vi.hoisted(() => vi.fn());
const stop = vi.hoisted(() => vi.fn());
vi.mock('../services/idle-app-reaper.js', () => ({ startIdlePauseReaper: start }));
vi.mock('../services/redis.js', () => ({ getRedisClient: () => ({}) }));
import plugin from './idle-pause-reaper.js';
beforeEach(() => { vi.clearAllMocks(); start.mockReturnValue(stop); vi.stubEnv('BUTTERBASE_IDLE_PAUSE_DAYS', '28'); vi.stubEnv('SKIP_IDLE_PAUSE_REAPER', ''); });
afterEach(() => vi.unstubAllEnvs());
it('starts on ready and stops before Fastify closes its databases', async () => {
  const app = Fastify(); app.decorate('controlDb', {} as never); app.decorate('runtimeDb', (() => ({})) as never);
  await app.register(plugin); await app.ready();
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ controlDb: app.controlDb, runtimeDb: expect.any(Function) }));
  await app.close(); expect(stop).toHaveBeenCalledOnce();
});
it('does not initialize any worker when disabled', async () => {
  vi.stubEnv('BUTTERBASE_IDLE_PAUSE_DAYS', '');
  const app = Fastify(); await app.register(plugin); await app.ready(); await app.close();
  expect(start).not.toHaveBeenCalled();
});
it('awaits in-flight sweep cleanup before closing the database', async () => {
  let finish!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  stop.mockImplementationOnce(() => { entered(); return gate; });
  let databaseClosed = false;
  const app = Fastify(); app.decorate('controlDb', {} as never); app.decorate('runtimeDb', (() => ({})) as never);
  app.addHook('onClose', async () => { databaseClosed = true; });
  await app.register(plugin); await app.ready();
  const closing = app.close();
  try {
    await started; await new Promise((resolve) => setImmediate(resolve));
    expect(databaseClosed).toBe(false);
  } finally { finish(); await closing; }
  expect(databaseClosed).toBe(true);
});
