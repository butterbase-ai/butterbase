// platform-event-bus.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPlatformEventBus } from './platform-event-bus.js';

describe('PlatformEventBus', () => {
  it('delivers emitted events to subscribers', async () => {
    const bus = createPlatformEventBus({ logger: { warn: vi.fn(), error: vi.fn() } });
    const handler = vi.fn();
    bus.subscribe('auth.signup.completed', handler);
    bus.emit('auth.signup.completed', {
      appId: 'app_1', userId: 'u1', email: 'a@x.com',
      displayName: null, provider: 'email', runtimeDb: {} as any,
    });
    await new Promise(r => setImmediate(r));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('swallows handler errors and logs them', async () => {
    const warn = vi.fn();
    const bus = createPlatformEventBus({ logger: { warn, error: vi.fn() } });
    bus.subscribe('auth.signup.completed', () => { throw new Error('boom'); });
    bus.emit('auth.signup.completed', {
      appId: 'app_1', userId: 'u1', email: 'a@x.com',
      displayName: null, provider: 'email', runtimeDb: {} as any,
    });
    await new Promise(r => setImmediate(r));
    expect(warn).toHaveBeenCalled();
  });

  it('unsubscribe stops further deliveries', async () => {
    const bus = createPlatformEventBus({ logger: { warn: vi.fn(), error: vi.fn() } });
    const handler = vi.fn();
    const off = bus.subscribe('auth.signup.completed', handler);
    off();
    bus.emit('auth.signup.completed', {
      appId: 'app_1', userId: 'u1', email: 'a@x.com',
      displayName: null, provider: 'email', runtimeDb: {} as any,
    });
    await new Promise(r => setImmediate(r));
    expect(handler).not.toHaveBeenCalled();
  });
});
