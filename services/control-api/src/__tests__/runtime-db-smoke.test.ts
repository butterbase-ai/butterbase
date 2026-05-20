import { describe, it, expect, afterAll } from 'vitest';
import { config, assertRegionConfig, assertRuntimeDbConfig } from '../config.js';
import { getRuntimeDbPool, _resetRuntimeDbPools } from '../services/runtime-db.js';

describe('runtime DB smoke (requires local runtime DB on :5437)', () => {
  afterAll(() => {
    _resetRuntimeDbPools();
  });

  it('connects and selects 1', async () => {
    if (!process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1) {
      console.warn('Skipping smoke test: NEON_RUNTIME_PROJECT_ID_US_EAST_1 not set');
      return;
    }
    assertRegionConfig();
    assertRuntimeDbConfig();
    const region = assertRegionConfig().instanceRegion;
    const pool = getRuntimeDbPool(config.runtimeDb, region);
    const { rows } = await pool.query('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
  });

  it('verifies _runtime_migrations exists with at least 1 row', async () => {
    if (!process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1) return;
    const region = assertRegionConfig().instanceRegion;
    const pool = getRuntimeDbPool(config.runtimeDb, region);
    const { rows } = await pool.query('SELECT count(*)::int AS c FROM _runtime_migrations');
    expect(rows[0].c).toBeGreaterThanOrEqual(1);
  });
});
