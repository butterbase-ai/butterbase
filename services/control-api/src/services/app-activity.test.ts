import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  region: vi.fn(async () => 'us-west-2'),
  lockedRegion: 'us-west-2',
  redisFor: vi.fn(), pool: vi.fn(),
  set: vi.fn(async () => 'OK' as string | null),
  del: vi.fn(async () => 1), query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
}));
vi.mock('./region-resolver.js', () => ({ resolveAppHomeRegion: io.region }));
vi.mock('./redis-registry.js', () => ({ redisFor: io.redisFor }));
vi.mock('./runtime-db.js', () => ({ getRuntimeDbPool: io.pool }));
vi.mock('../config.js', () => ({ config: { runtimeDb: {} } }));
vi.mock('./app-state-lock.js', () => ({ withAppStateLocks: async (_db: unknown, ids: string[], work: Function) =>
  work(ids.map(app_id=>({ app_id,region:io.lockedRegion })),{}) }));
const { markAppActive } = await import('./app-activity.js');
const control = {} as never;
const log = { warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  io.lockedRegion = 'us-west-2';
  io.region.mockResolvedValue('us-west-2');
  io.redisFor.mockReturnValue({ set: io.set, del: io.del });
  io.pool.mockReturnValue({ query: io.query });
  io.set.mockResolvedValue('OK'); io.query.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('markAppActive', () => {
  it('records traffic in the locked home if the app moved after throttle lookup', async () => {
    io.lockedRegion = 'eu-west-1';
    await markAppActive(control,'app_used',log);
    expect(io.pool).toHaveBeenCalledWith({},'eu-west-1');
  });
  it('stamps activity and clears warning/grace state in the home region', async () => {
    await markAppActive(control, 'app_used', log);
    expect(io.redisFor).toHaveBeenCalledWith('us-west-2');
    expect(io.pool).toHaveBeenCalledWith({}, 'us-west-2');
    expect(io.set).toHaveBeenCalledWith('app:active:app_used', '1', 'EX', 3600, 'NX');
    expect(io.query).toHaveBeenCalledWith(expect.stringMatching(/last_active_at = now\(\)/), ['app_used']);
    const sql = io.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/idle_warned_at = NULL/);
    expect(sql).toMatch(/idle_reminded_at = NULL/);
    expect(sql).toMatch(/idle_pause_notified_at = NULL/);
    expect(sql).toMatch(/paused = false/);
  });

  it('does not write when another request holds the hourly throttle', async () => {
    io.set.mockResolvedValue(null);
    await markAppActive(control, 'app_used', log);
    expect(io.query).not.toHaveBeenCalled();
  });
  it('records returning traffic directly in the runtime DB when regional Redis is unavailable', async () => {
    io.set.mockRejectedValueOnce(new Error('regional Redis down'));
    await markAppActive(control, 'app_returned', log);
    expect(io.query).toHaveBeenCalledWith(expect.stringMatching(/last_active_at = now\(\)/), ['app_returned']);
    expect(io.query.mock.calls[0][0]).toMatch(/interval '1 hour'/);
    expect(io.del).not.toHaveBeenCalled();
  });

  it('releases the throttle after a failed DB write so later traffic can retry', async () => {
    io.query.mockRejectedValueOnce(new Error('runtime unavailable'));
    await expect(markAppActive(control, 'app_used', log)).resolves.toBeUndefined();
    expect(io.del).toHaveBeenCalledWith('app:active:app_used');
    expect(log.warn).toHaveBeenCalled();
    await markAppActive(control, 'app_used', log);
    expect(io.query).toHaveBeenCalledTimes(2);
  });

  it.each(['lookup', 'redis', 'cleanup'])('never fails a response when %s fails', async (step) => {
    if (step === 'lookup') io.region.mockRejectedValueOnce(new Error('unknown app'));
    if (step === 'redis') io.set.mockRejectedValueOnce(new Error('redis down'));
    if (step === 'cleanup') {
      io.query.mockRejectedValueOnce(new Error('db down'));
      io.del.mockRejectedValueOnce(new Error('redis down'));
    }
    await expect(markAppActive(control, 'app_used', log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
