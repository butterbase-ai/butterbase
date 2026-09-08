import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  setStagingOverrides, getStagingOverrides, mergeStagingOverrides,
} from './staging-overrides.js';

const RUNTIME_URL =
  process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ??
  'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let runtimeDb: pg.Pool;
const STAGING = 'app_test_ovr_staging';
const USER = '00000000-0000-0000-0000-0000000000e2';

beforeAll(async () => {
  process.env.AUTH_ENCRYPTION_KEY ??= 'a'.repeat(64);
  runtimeDb = new pg.Pool({ connectionString: RUNTIME_URL });
  await runtimeDb.query(
    `INSERT INTO apps (id, name, owner_id, db_name, region)
     VALUES ($1, $1, $2, $1, 'us-east-1') ON CONFLICT (id) DO NOTHING`,
    [STAGING, USER],
  );
});

afterAll(async () => {
  await runtimeDb.query(`DELETE FROM apps WHERE id = $1`, [STAGING]);
  await runtimeDb.end();
});

beforeEach(async () => {
  await runtimeDb.query(`DELETE FROM staging_env_overrides WHERE staging_app_id = $1`, [STAGING]);
});

describe('staging overrides', () => {
  it('round-trips values through encryption', async () => {
    await setStagingOverrides(runtimeDb, STAGING, { STRIPE_KEY: 'sk_test_123' }, USER);
    expect(await getStagingOverrides(runtimeDb, STAGING)).toEqual({ STRIPE_KEY: 'sk_test_123' });
  });

  it('stores ciphertext, not the plaintext value', async () => {
    await setStagingOverrides(runtimeDb, STAGING, { STRIPE_KEY: 'sk_test_123' }, USER);
    const row = await runtimeDb.query(
      `SELECT encrypted_overrides FROM staging_env_overrides WHERE staging_app_id = $1`, [STAGING],
    );
    expect(row.rows[0].encrypted_overrides).not.toContain('sk_test_123');
  });

  it('returns an empty object when nothing is set', async () => {
    expect(await getStagingOverrides(runtimeDb, STAGING)).toEqual({});
  });

  it('overwrites on repeat set', async () => {
    await setStagingOverrides(runtimeDb, STAGING, { A: '1' }, USER);
    await setStagingOverrides(runtimeDb, STAGING, { A: '2' }, USER);
    expect(await getStagingOverrides(runtimeDb, STAGING)).toEqual({ A: '2' });
  });

  it('rejects instead of returning {} when AUTH_ENCRYPTION_KEY is missing', async () => {
    // Insert the row while the key is still set, then unset it for the read.
    await setStagingOverrides(runtimeDb, STAGING, { STRIPE_KEY: 'sk_test_123' }, USER);
    const original = process.env.AUTH_ENCRYPTION_KEY;
    delete process.env.AUTH_ENCRYPTION_KEY;
    try {
      await expect(getStagingOverrides(runtimeDb, STAGING)).rejects.toThrow(
        'AUTH_ENCRYPTION_KEY not configured',
      );
    } finally {
      process.env.AUTH_ENCRYPTION_KEY = original;
    }
  });

  it('returns {} without throwing for a corrupt stored blob when the key is set', async () => {
    await runtimeDb.query(
      `INSERT INTO staging_env_overrides (staging_app_id, encrypted_overrides, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (staging_app_id) DO UPDATE
         SET encrypted_overrides = EXCLUDED.encrypted_overrides`,
      [STAGING, 'not:a:validciphertext', USER],
    );
    expect(await getStagingOverrides(runtimeDb, STAGING)).toEqual({});
  });
});

describe('mergeStagingOverrides', () => {
  it('lets overrides win over inherited values', () => {
    expect(mergeStagingOverrides({ A: 'prod', B: 'prod' }, { A: 'staging' }))
      .toEqual({ A: 'staging', B: 'prod' });
  });

  it('keeps inherited values when there are no overrides', () => {
    expect(mergeStagingOverrides({ A: 'prod' }, {})).toEqual({ A: 'prod' });
  });
});
