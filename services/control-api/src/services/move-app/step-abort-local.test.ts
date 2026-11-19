import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// All resource operations are fakes: these tests never open Postgres or Redis.
vi.mock('../app-db-teardown.js', () => ({
  teardownAppDb: vi.fn().mockResolvedValue({ mode: 'local', alreadyGone: false }),
}));
vi.mock('../kv/migration-sentinel.js', () => ({ clearKvBlock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../kv/redis-registry.js', () => ({ kvRedisFor: vi.fn().mockReturnValue({}) }));
vi.mock('../kv/redis-client.js', () => ({ wrap: vi.fn().mockImplementation((redis: unknown) => redis) }));
vi.mock('../region-resolver.js', () => ({ invalidateAppRegion: vi.fn().mockResolvedValue(undefined) }));

import { teardownAppDb } from '../app-db-teardown.js';
import { custDbNameFor } from '../app-db-name.js';
import { executeAbort } from './step-abort.js';
import type { MigrationRow } from './migration-store.js';
import type { SagaCtx } from './saga-executor.js';

const SOURCE_REGION = 'us-east-1';
const DEST_REGION = 'eu-west-1';
const DEST_URL_ENV = 'LOCAL_DATA_PLANE_URL_EU_WEST_1';

function migration(overrides: Partial<MigrationRow> = {}): MigrationRow {
  return {
    id: 'migration-local-unit',
    app_id: 'app-local-unit',
    user_id: 'owner-local-unit',
    source_region: SOURCE_REGION,
    dest_region: DEST_REGION,
    current_step: 'aborting',
    step_started_at: new Date('2026-01-01T00:00:00Z'),
    last_error: 'fixture runtime connection INSERT failure',
    retry_count: 5,
    dest_resources: {},
    source_replica_state: 'none',
    initiated_at: new Date('2026-01-01T00:00:00Z'),
    completed_at: null,
    ...overrides,
  };
}

function context(m: MigrationRow, deletedRows: { id: string }[] = [{ id: m.app_id }]) {
  const sourceQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const destQuery = vi.fn().mockResolvedValue({ rows: deletedRows, rowCount: deletedRows.length });
  const ctx: SagaCtx = {
    controlPool: { query: vi.fn() } as unknown as SagaCtx['controlPool'],
    runtimePoolFor: vi.fn().mockImplementation((region: string) => {
      if (region === m.source_region) return { query: sourceQuery };
      if (region === m.dest_region) return { query: destQuery };
      throw new Error('unexpected fixture region');
    }),
    redisFor: vi.fn().mockReturnValue({}),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { ctx, sourceQuery, destQuery };
}

function expectNoInferredDrop() {
  // The existing metadata-less teardown may still run in skipped mode; no
  // guessed database identity may reach it without an owned reservation.
  for (const [args] of vi.mocked(teardownAppDb).mock.calls) {
    expect(args.neonDatabaseName == null).toBe(true);
    expect(args.neonProjectId == null).toBe(true);
  }
}

function expectConditionalReservationDelete(query: ReturnType<typeof vi.fn>, m: MigrationRow) {
  expect(query).toHaveBeenCalledOnce();
  const [sql, args] = query.mock.calls[0] as [string, unknown[]];
  const normalized = sql.replace(/\s+/g, ' ');
  expect(normalized).toMatch(/DELETE FROM apps/i);
  expect(normalized).toMatch(/owner_id\s*=\s*\$\d+/i);
  expect(normalized).toMatch(/region\s*=\s*\$\d+/i);
  expect(normalized).toMatch(/provisioning_status\s*=\s*'migration_target_reserved'/i);
  expect(normalized).toMatch(/right\(\s*(?:\w+\.)?db_name\s*,\s*9\s*\)\s*=\s*'__pending'/i);
  expect(normalized).toMatch(/NOT EXISTS/i);
  expect(normalized).toMatch(/neon_project_id\s+IS NOT NULL/i);
  expect(normalized).toMatch(/RETURNING\s+(?:\w+\.)?id\b/i);
  expect(args).toEqual([m.app_id, m.user_id, m.dest_region]);
}

describe('executeAbort — local reservation without persisted resource metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('BUTTERBASE_LOCAL', 'true');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv(DEST_URL_ENV, 'postgresql://fixture:fixture@127.0.0.1:1/postgres');
    vi.mocked(teardownAppDb).mockResolvedValue({ mode: 'local', alreadyGone: false });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('tears down an inferred local database only after claiming the owned pending reservation', async () => {
    const m = migration();
    const { ctx, destQuery, sourceQuery } = context(m);

    await expect(executeAbort(ctx, m)).resolves.toMatchObject({ next: 'aborted' });

    expectConditionalReservationDelete(destQuery, m);
    expect(teardownAppDb).toHaveBeenCalledWith(expect.objectContaining({
      region: m.dest_region,
      neonDatabaseName: custDbNameFor(m.app_id, m.dest_region),
    }));
    expect(destQuery.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(teardownAppDb).mock.invocationCallOrder[0]);
    expect(sourceQuery).toHaveBeenCalledWith(expect.stringContaining("provisioning_status = 'ready'"), [m.app_id]);
  });

  it('does not infer a DROP when DELETE RETURNING claims no reservation', async () => {
    const m = migration();
    const { ctx, destQuery } = context(m, []);

    await expect(executeAbort(ctx, m)).resolves.toMatchObject({ next: 'aborted' });

    expectConditionalReservationDelete(destQuery, m);
    expectNoInferredDrop();
  });

  it('does not delete a reservation or infer a DROP for a same-region migration', async () => {
    const m = migration({ dest_region: SOURCE_REGION });
    const { ctx, destQuery, sourceQuery } = context(m);

    await executeAbort(ctx, m);

    expect(destQuery).not.toHaveBeenCalled();
    expect(sourceQuery.mock.calls.some(([sql]) => /DELETE FROM/i.test(String(sql)))).toBe(false);
    expectNoInferredDrop();
  });

  it('leaves the destination reservation alone in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const m = migration();
    const { ctx, destQuery } = context(m);

    await executeAbort(ctx, m);

    expect(destQuery).not.toHaveBeenCalled();
    expectNoInferredDrop();
  });

  it.each(['false', undefined])('leaves the destination reservation alone with local mode %s', async (flag) => {
    vi.stubEnv('BUTTERBASE_LOCAL', flag);
    const m = migration();
    const { ctx, destQuery } = context(m);

    await executeAbort(ctx, m);

    expect(destQuery).not.toHaveBeenCalled();
    expectNoInferredDrop();
  });

  it.each([undefined, 'not a URL', 'https://fixture.invalid/postgres'])('keeps the reservation when the explicit local URL is %s', async (url) => {
    vi.stubEnv(DEST_URL_ENV, url);
    const m = migration();
    const { ctx, destQuery } = context(m);

    await executeAbort(ctx, m);

    expect(destQuery).not.toHaveBeenCalled();
    expectNoInferredDrop();
  });

  it('keeps both resources when 63-character database-name truncation collides across regions', async () => {
    const m = migration({ app_id: 'app_' + 'x'.repeat(70) });
    const name = custDbNameFor(m.app_id, m.dest_region);
    expect(name).toHaveLength(63);
    expect(custDbNameFor(m.app_id, m.source_region)).toBe(name);
    const { ctx, destQuery } = context(m);

    await executeAbort(ctx, m);

    expect(destQuery).not.toHaveBeenCalled();
    expectNoInferredDrop();
  });

  it('does not infer a DROP when the conditional reservation DELETE fails', async () => {
    const m = migration();
    const { ctx, destQuery, sourceQuery } = context(m);
    destQuery.mockRejectedValue(new Error('fixture reservation DELETE rejected'));

    await expect(executeAbort(ctx, m)).resolves.toMatchObject({ next: 'aborted' });

    expectConditionalReservationDelete(destQuery, m);
    expectNoInferredDrop();
    expect(ctx.log.warn).toHaveBeenCalled();
    expect(sourceQuery).toHaveBeenCalledWith(expect.stringContaining("provisioning_status = 'ready'"), [m.app_id]);
  });
});
