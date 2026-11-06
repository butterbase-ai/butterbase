import { describe, it, expect, vi } from 'vitest';

const handlers: Array<(ch: string, msg: string) => void> = [];
const sub = { subscribe: vi.fn(async () => 1), unsubscribe: vi.fn(async () => 1) };
const regionRedis = { publish: vi.fn(async () => 1) };
vi.mock('../redis.js', async (orig) => ({
  ...(await orig<object>()),
  getRedisSubClient: () => sub,
  getRedisClient: () => ({ del: vi.fn(async () => 1), set: vi.fn(async () => 'OK') }),
  onRedisMessage: (h: any) => handlers.push(h),
}));
vi.mock('../redis-registry.js', () => ({ redisFor: () => regionRedis }));
vi.mock('../runtime-pool-registry.js', () => ({ listRuntimeRegions: () => ['us-east-1', 'us-west-2'] }));

const { RealtimeManager, broadcastCloseApp, REALTIME_CONTROL_CHANNEL } = await import('../realtime-manager.js');

function fakeSocket() { return { send: vi.fn(), close: vi.fn(), readyState: 1 }; }
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function seed(m: any, appId: string, socket: any) {
  const client = { socket, appId, userId: null, role: 'butterbase_anon', subscribedTables: new Map(), clientId: appId, presenceMetadata: null };
  const listener = {
    appId, dbName: 'db', client: null, subscribers: new Set<any>([client]), connected: false,
    reconnectTimer: null, teardownTimer: null, reconnectAttempts: 0, connectionString: null,
  };
  m.listeners.set(appId, listener);
  m.clientMap.set(socket, client);
}

describe('RealtimeManager.closeApp', () => {
  it("closes only that app's sockets with 1013 and tears down its listener", () => {
    const m = new RealtimeManager({} as never, logger());
    const a = fakeSocket(); const b = fakeSocket();
    seed(m, 'app_a', a); seed(m, 'app_b', b);

    m.closeApp('app_a');

    expect(a.close).toHaveBeenCalledWith(1013, 'App paused');
    expect(b.close).not.toHaveBeenCalled();
    expect((m as any).listeners.has('app_a')).toBe(false);
    expect((m as any).listeners.has('app_b')).toBe(true);
    expect((m as any).clientMap.has(a)).toBe(false);
  });

  it('closeApp on an app with no listener is a no-op', () => {
    const m = new RealtimeManager({} as never, logger());
    expect(() => m.closeApp('nope')).not.toThrow();
  });

  it('broadcastCloseApp publishes to every region', async () => {
    await broadcastCloseApp('app_a');
    expect(regionRedis.publish).toHaveBeenCalledTimes(2);
    expect(regionRedis.publish).toHaveBeenCalledWith(REALTIME_CONTROL_CHANNEL, JSON.stringify({ type: 'close_app', appId: 'app_a' }));
  });

  it('start() subscribes to the control channel and routes close_app to closeApp', async () => {
    vi.useFakeTimers();
    handlers.length = 0;
    const m = new RealtimeManager({} as never, logger());
    const a = fakeSocket();
    seed(m, 'app_a', a);
    m.start();
    expect(sub.subscribe).toHaveBeenCalledWith(REALTIME_CONTROL_CHANNEL);

    handlers[0](REALTIME_CONTROL_CHANNEL, JSON.stringify({ type: 'close_app', appId: 'app_a' }));
    expect(a.close).toHaveBeenCalledWith(1013, 'App paused');

    // a malformed payload is swallowed, not thrown
    expect(() => handlers[0](REALTIME_CONTROL_CHANNEL, 'not json')).not.toThrow();

    await m.shutdown();
    vi.useRealTimers();
  });
});
