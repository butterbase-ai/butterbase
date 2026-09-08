/**
 * THE REGRESSION THIS FILE EXISTS FOR
 *
 * `replayAppEnvVars` copied production's entire app-level env var blob into the
 * clone destination, and `executeClone` called it with no options for every
 * mode — including `staging_create`. `staging-overrides.ts` (the store built to
 * let an owner swap a live key for a sandbox key in staging) had zero non-test
 * callers. Result: a staging app ran with production's live Stripe / SendGrid
 * credentials, and an HTTP-triggered function in staging charged real cards.
 *
 * Neither half was individually wrong, which is why no per-task test caught it:
 * `replayAppEnvVars`'s own tests asserted it copies values (correct for a
 * clone), and `staging-overrides.test.ts` asserted the store round-trips
 * (correct in isolation). The defect lived in the JOIN. So these tests drive
 * the composition the worker actually performs —
 * `getStagingOverrides` -> `appEnvReplayOptsForCloneMode(job.mode, ...)` ->
 * `replayAppEnvVars` — and assert on what the staging app ends up holding.
 *
 * Every assertion below fails against the pre-fix code.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { encrypt, decrypt } from '../crypto.js';
import { replayAppEnvVars, appEnvReplayOptsForCloneMode } from '../clone-app-env.js';
import {
  setStagingOverrides, getStagingOverrides, applyStagingOverridesToAppEnv,
} from '../staging-overrides.js';

const RUNTIME_URL =
  process.env.RUNTIME_DB_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let runtimeDb: pg.Pool;
let encKey: string;

const SUFFIX = randomUUID().slice(0, 8);
const PROD = `app_stgenv_prod_${SUFFIX}`;
const STAGING = `app_stgenv_staging_${SUFFIX}`;
const CLONE = `app_stgenv_clone_${SUFFIX}`;
const USER = randomUUID();

// The production values that must never appear in the staging app.
const PROD_ENV = {
  STRIPE_SECRET_KEY: 'sk_live_PRODUCTION_CHARGES_REAL_CARDS',
  SENDGRID_API_KEY: 'SG.PRODUCTION_SENDS_REAL_EMAIL',
  // Deliberately innocuous-looking: no name or value heuristic flags this, and
  // withholding must not depend on one.
  TENANT_MODE: 'live',
};

/** Decrypt whatever `appId` currently holds in app_env_vars. */
async function readEnv(appId: string): Promise<Record<string, string>> {
  const row = await runtimeDb.query<{ encrypted_env_vars: string }>(
    `SELECT encrypted_env_vars FROM app_env_vars WHERE app_id = $1`, [appId],
  );
  if (row.rows.length === 0) return {};
  return JSON.parse(decrypt(row.rows[0].encrypted_env_vars, encKey));
}

/**
 * Exactly what executeClone does for a given job mode. Keeping this in one
 * helper is the point: the bug was that the worker never varied by mode.
 */
async function materializeForMode(mode: string, destAppId: string) {
  const overrides = mode === 'staging_create'
    ? await getStagingOverrides(runtimeDb, destAppId)
    : undefined;
  return replayAppEnvVars(
    runtimeDb, runtimeDb, PROD, destAppId, USER,
    appEnvReplayOptsForCloneMode(mode, overrides),
  );
}

beforeAll(async () => {
  process.env.AUTH_ENCRYPTION_KEY ??= 'a'.repeat(64);
  encKey = process.env.AUTH_ENCRYPTION_KEY!;
  runtimeDb = new pg.Pool({ connectionString: RUNTIME_URL });
  for (const id of [PROD, STAGING, CLONE]) {
    await runtimeDb.query(
      `INSERT INTO apps (id, name, owner_id, db_name, region)
       VALUES ($1, $1, $2, $1, 'us-east-1') ON CONFLICT (id) DO NOTHING`,
      [id, USER],
    );
  }
});

afterAll(async () => {
  await runtimeDb.query(`DELETE FROM app_env_vars WHERE app_id = ANY($1::text[])`, [[PROD, STAGING, CLONE]]);
  await runtimeDb.query(`DELETE FROM staging_env_overrides WHERE staging_app_id = $1`, [STAGING]);
  await runtimeDb.query(`DELETE FROM apps WHERE id = ANY($1::text[])`, [[PROD, STAGING, CLONE]]);
  await runtimeDb.end();
});

beforeEach(async () => {
  await runtimeDb.query(`DELETE FROM app_env_vars WHERE app_id = ANY($1::text[])`, [[PROD, STAGING, CLONE]]);
  await runtimeDb.query(`DELETE FROM staging_env_overrides WHERE staging_app_id = $1`, [STAGING]);
  await runtimeDb.query(
    `INSERT INTO app_env_vars (app_id, encrypted_env_vars, updated_by) VALUES ($1, $2, $3)`,
    [PROD, encrypt(JSON.stringify(PROD_ENV), encKey), USER],
  );
});

describe('staging_create env materialisation (the defect)', () => {
  it('never gives staging production\'s value for an OVERRIDDEN key', async () => {
    await setStagingOverrides(runtimeDb, STAGING, { STRIPE_SECRET_KEY: 'sk_test_SANDBOX' }, USER);

    await materializeForMode('staging_create', STAGING);

    const staged = await readEnv(STAGING);
    // This single assertion is the one that fails on the pre-fix code: without
    // the override wired in, staged.STRIPE_SECRET_KEY was the live production key.
    expect(staged.STRIPE_SECRET_KEY).toBe('sk_test_SANDBOX');
    expect(staged.STRIPE_SECRET_KEY).not.toBe(PROD_ENV.STRIPE_SECRET_KEY);
  });

  it('never gives staging production\'s value for a NON-overridden key either', async () => {
    await setStagingOverrides(runtimeDb, STAGING, { STRIPE_SECRET_KEY: 'sk_test_SANDBOX' }, USER);

    await materializeForMode('staging_create', STAGING);

    const staged = await readEnv(STAGING);
    // Key NAME survives so the owner can see what to fill; the value does not.
    expect(Object.keys(staged).sort()).toEqual(
      ['SENDGRID_API_KEY', 'STRIPE_SECRET_KEY', 'TENANT_MODE'],
    );
    expect(staged.SENDGRID_API_KEY).toBe('');
    expect(staged.TENANT_MODE).toBe('');
  });

  it('leaks no production value at all into the staging blob', async () => {
    await materializeForMode('staging_create', STAGING);

    const stagedValues = Object.values(await readEnv(STAGING));
    for (const secret of Object.values(PROD_ENV)) {
      expect(stagedValues).not.toContain(secret);
    }
  });

  it('names every withheld key so the create job can disclose it', async () => {
    await setStagingOverrides(runtimeDb, STAGING, { STRIPE_SECRET_KEY: 'sk_test_SANDBOX' }, USER);

    const res = await materializeForMode('staging_create', STAGING);

    // An overridden key is NOT withheld — it has a real (sandbox) value.
    expect(res.withheldKeys?.sort()).toEqual(['SENDGRID_API_KEY', 'TENANT_MODE']);
    expect(res.overriddenKeys).toEqual(['STRIPE_SECRET_KEY']);
    // Names only: no value ever appears in the disclosure surface.
    const disclosed = JSON.stringify(res);
    for (const secret of Object.values(PROD_ENV)) {
      expect(disclosed).not.toContain(secret);
    }
  });

  it('with no overrides set (the first-create window) staging holds no live value', async () => {
    const res = await materializeForMode('staging_create', STAGING);

    expect(await readEnv(STAGING)).toEqual({
      STRIPE_SECRET_KEY: '', SENDGRID_API_KEY: '', TENANT_MODE: '',
    });
    expect(res.withheldKeys?.sort()).toEqual(
      ['SENDGRID_API_KEY', 'STRIPE_SECRET_KEY', 'TENANT_MODE'],
    );
  });

  it('an override for a key production does not define still lands', async () => {
    await setStagingOverrides(runtimeDb, STAGING, { STAGING_ONLY_FLAG: 'yes' }, USER);

    await materializeForMode('staging_create', STAGING);

    expect((await readEnv(STAGING)).STAGING_ONLY_FLAG).toBe('yes');
  });
});

describe('non-staging modes are unchanged', () => {
  it.each(['clone', 'update', 'promote'])(
    '%s copies production values verbatim, as before', async (mode) => {
      const res = await materializeForMode(mode, CLONE);

      expect(res).toEqual({ copied: true, keyCount: 3 });
      expect(await readEnv(CLONE)).toEqual(PROD_ENV);
    },
  );

  it('appEnvReplayOptsForCloneMode opts in for staging_create only', () => {
    for (const mode of ['clone', 'update', 'promote', 'staging_reset']) {
      expect(appEnvReplayOptsForCloneMode(mode, { A: '1' })).toBeUndefined();
    }
    expect(appEnvReplayOptsForCloneMode('staging_create', { A: '1' })).toEqual({
      overrides: { A: '1' }, withholdInheritedValues: true,
    });
  });
});

describe('applyStagingOverridesToAppEnv (the write path that makes overrides usable)', () => {
  it('overwrites an inherited-then-withheld key with the owner\'s sandbox value', async () => {
    await materializeForMode('staging_create', STAGING);
    expect((await readEnv(STAGING)).STRIPE_SECRET_KEY).toBe('');

    await applyStagingOverridesToAppEnv(
      runtimeDb, STAGING, { STRIPE_SECRET_KEY: 'sk_test_SANDBOX' }, USER,
    );

    const staged = await readEnv(STAGING);
    expect(staged.STRIPE_SECRET_KEY).toBe('sk_test_SANDBOX');
    // Merge, not replace: the other keys are still present and still empty.
    expect(staged.SENDGRID_API_KEY).toBe('');
  });

  it('preserves values the owner set directly on staging via PATCH /v1/:appId/env', async () => {
    await runtimeDb.query(
      `INSERT INTO app_env_vars (app_id, encrypted_env_vars, updated_by) VALUES ($1, $2, $3)`,
      [STAGING, encrypt(JSON.stringify({ SET_BY_HAND: 'keep-me' }), encKey), USER],
    );

    await applyStagingOverridesToAppEnv(runtimeDb, STAGING, { STRIPE_SECRET_KEY: 'sk_test_X' }, USER);

    expect(await readEnv(STAGING)).toEqual({
      SET_BY_HAND: 'keep-me', STRIPE_SECRET_KEY: 'sk_test_X',
    });
  });
});
