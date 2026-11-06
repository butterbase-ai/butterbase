import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./idle-pause-emails.js', () => ({ sendIdlePauseEmail: vi.fn(), sendIdlePauseBreakerEmail: vi.fn() }));
import { runIdlePauseOnce, startIdlePauseReaper, type IdleReaperDeps } from './idle-app-reaper.js';
import { idlePauseConfigFromEnv } from './idle-pause-config.js';

let stop: (() => void | Promise<void>) | undefined;
let deps: IdleReaperDeps;
const cfg = idlePauseConfigFromEnv({ BUTTERBASE_IDLE_PAUSE_DAYS: '28' })!;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('BUTTERBASE_IDLE_PAUSE_DAYS', '28'); vi.stubEnv('SKIP_IDLE_PAUSE_REAPER', '');
  deps = {
    controlDb: { query: vi.fn(async () => ({ rows: [] })) } as never,
    runtimeDb: vi.fn(),
    redis: { set: vi.fn(async () => 'OK'), eval: vi.fn(async () => 1) },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
afterEach(async () => { await stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('idle reaper lifecycle and lease', () => {
  it.each(['', '0', 'bogus'])('stays entirely off when DAYS is %s', async (days) => {
    vi.stubEnv('BUTTERBASE_IDLE_PAUSE_DAYS', days);
    stop = startIdlePauseReaper(deps);
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(deps.redis.set).not.toHaveBeenCalled();
  });
  it('starts immediately, recurs every six hours, and stops scheduling', async () => {
    stop = startIdlePauseReaper(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.redis.set).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 3600_000 - 1);
    expect(deps.redis.set).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.redis.set).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(deps.redis.set).toHaveBeenCalledTimes(2);
  });
  it('does not schedule a new tick when stopped while a sweep is in flight', async () => {
    let finish!: (value: string) => void;
    vi.mocked(deps.redis.set).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    stop = startIdlePauseReaper(deps); stop(); finish('OK');
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(deps.redis.set).toHaveBeenCalledOnce();
  });
  it('stop returns a promise that waits for the active sweep to finish', async () => {
    let finish!: (value: string) => void;
    vi.mocked(deps.redis.set).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    stop = startIdlePauseReaper(deps);
    const draining = stop();
    expect(draining).toBeInstanceOf(Promise);
    finish('OK'); await draining;
  });
  it('logs Redis failure and retries on the next scheduled tick', async () => {
    vi.mocked(deps.redis.set).mockRejectedValueOnce(new Error('Redis down'));
    stop = startIdlePauseReaper(deps, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.log.error).toHaveBeenCalled(); expect(deps.redis.set).toHaveBeenCalledTimes(2);
  });
  it('releases only its own lease when control-plane selection fails', async () => {
    vi.mocked(deps.controlDb.query).mockRejectedValueOnce(new Error('control down'));
    await expect(runIdlePauseOnce(deps, cfg)).rejects.toThrow('control down');
    const token = vi.mocked(deps.redis.set).mock.calls[0][1];
    expect(deps.redis.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('get'"), 1, 'lock:idle-pause-reaper', token);
  });
  it('never starts a second scan while the previous tick is unresolved', async () => {
    let finish!: (value: string) => void;
    vi.mocked(deps.redis.set).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    stop = startIdlePauseReaper(deps, 1000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(deps.redis.set).toHaveBeenCalledOnce(); finish('OK');
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.redis.set).toHaveBeenCalledTimes(2);
  });
});
