import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../plugins/pause-gate.js', () => ({ assertAppIdNotPaused: vi.fn() }));
vi.mock('../../services/region-resolver.js', async (orig) => ({
  ...(await orig<object>()),
  getRuntimeDbForApp: vi.fn(async () => ({
    query: vi.fn(async () => ({ rows: [{ name: 'onPing', trigger_config: { event: 'ping' } }] })),
  })),
}));

const { handleWebSocketEvent } = await import('../realtime.js');
const { assertAppIdNotPaused } = await import('../../plugins/pause-gate.js');
const { AppPausedError } = await import('../../services/app-resolver.js');

describe('ws trigger on a paused app', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const fastify = { controlDb: {}, log: { error: vi.fn() } } as never;

  it('sends an APP_PAUSED error and does not call the runtime', async () => {
    vi.mocked(assertAppIdNotPaused).mockRejectedValueOnce(new AppPausedError('app_1', null, 'idle_reaper'));
    const socket = { send: vi.fn() };
    await handleWebSocketEvent(fastify, 'app_1', null, 'ping', {}, socket as never);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: 'error', code: 'APP_PAUSED', message: 'App is paused' });
  });

  it('forwards to the runtime when the app is running', async () => {
    vi.mocked(assertAppIdNotPaused).mockResolvedValueOnce(undefined);
    const socket = { send: vi.fn() };
    await handleWebSocketEvent(fastify, 'app_1', null, 'ping', {}, socket as never);
    expect(fetchSpy).toHaveBeenCalled();
  });
});
