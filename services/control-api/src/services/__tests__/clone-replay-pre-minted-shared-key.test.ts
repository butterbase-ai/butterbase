import { describe, it, expect } from 'vitest';
import { replayFunctions } from '../clone-replay.js';
import { decrypt, encrypt } from '../crypto.js';
import { runtimeDb, controlDb, seedUser } from '../../__tests__/test-helpers/control-db.js';

// This file covers the DO/fn parity path introduced with `preMintedSharedKey`.
// When the orchestrator (neon-task-worker) mints a shared bb_sk_* for the DO
// side, it passes the same key into replayFunctions so both sides carry the
// exact same intra-app credential. Two invariants under test:
//   1. The value is reused verbatim (fn env decrypts to the exact string passed).
//   2. No second mint happens — api_keys stays empty for that clone.
// The companion "existing behavior when not provided" case is already covered
// by clone-replay-env-vars.test.ts:96 ("mints exactly one shared bb_sk_*").

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

const noopLogger = { info() {}, warn() {} };

describeDb('replayFunctions honors preMintedSharedKey', () => {
  it('reuses the pre-minted key verbatim across every convention-key function', async () => {
    const { id: ownerId } = await seedUser(`pre-minted-${Date.now()}@x.com`);
    const srcId = `app_pre_src_${ownerId.slice(0, 8)}`;
    const destId = `app_pre_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerId],
      );
    }
    // Every source fn declares BUTTERBASE_API_KEY, so replayFunctions'
    // convention detection triggers on all three.
    const enc = encrypt(
      JSON.stringify({ BUTTERBASE_API_KEY: 'placeholder-in-source' }),
      process.env.AUTH_ENCRYPTION_KEY!,
    );
    for (const fn of ['agent-chat', 'ingest', 'cron']) {
      await runtimeDb.query(
        `INSERT INTO app_functions (id, app_id, name, code, encrypted_env_vars, deployed_by)
         VALUES (gen_random_uuid(), $1, $2, '/* code */', $3, $4)`,
        [srcId, fn, enc, ownerId],
      );
    }

    // The sentinel value we hand in — a real orchestrator would pass a freshly
    // minted bb_sk_*, but for testing the reuse path any string works.
    const PRE_MINTED = 'bb_sk_pre_minted_from_orchestrator_12345';

    const result = await replayFunctions(
      runtimeDb, runtimeDb, srcId, destId, ownerId, noopLogger,
      {
        // preMintedSharedKey is set; controlPool/destAppOwnerId are NOT passed
        // because the precondition check in clone-replay.ts should only fire
        // when the internal mint path is taken.
        preMintedSharedKey: PRE_MINTED,
      },
    );
    expect(result.warnings).toEqual([]);
    expect(result.unfilledEnvVars).toEqual({});

    const rows = await runtimeDb.query<{ name: string; encrypted_env_vars: string }>(
      `SELECT name, encrypted_env_vars FROM app_functions WHERE app_id = $1 ORDER BY name`,
      [destId],
    );
    expect(rows.rows.length).toBe(3);
    for (const r of rows.rows) {
      const env = JSON.parse(decrypt(r.encrypted_env_vars, process.env.AUTH_ENCRYPTION_KEY!));
      expect(env.BUTTERBASE_API_KEY).toBe(PRE_MINTED);
    }

    // No API key rows on control-plane — this is the whole point: the
    // orchestrator already minted, replayFunctions must NOT mint again.
    const keyRows = await controlDb.query<{ id: string }>(
      `SELECT id FROM api_keys WHERE user_id = $1 AND name LIKE $2`,
      [ownerId, `Auto-mint for clone (${destId})%`],
    );
    expect(keyRows.rows.length).toBe(0);

    await runtimeDb.query(`DELETE FROM app_functions WHERE app_id IN ($1, $2)`, [srcId, destId]);
    await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
    // platform_users → organizations order: FK is user.personal_organization_id
    // → orgs.id, so users must go first.
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
    await controlDb.query(`DELETE FROM organizations WHERE owner_id = $1`, [ownerId]);
  });

  it('does not require controlPool/destAppOwnerId when preMintedSharedKey is set', async () => {
    // Regression guard: pre-Phase-4 the precondition check hard-failed the
    // clone if controlPool + destAppOwnerId were absent, even when a caller
    // had already minted the key. That would defeat the whole point of the
    // orchestrator-level mint: the DO side would mint, but the fn side would
    // still throw. Verify the precondition is bypassed when preMintedSharedKey
    // is supplied.
    const { id: ownerId } = await seedUser(`pre-mint-precond-${Date.now()}@x.com`);
    const srcId = `app_pre_pc_src_${ownerId.slice(0, 8)}`;
    const destId = `app_pre_pc_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerId],
      );
    }
    const enc = encrypt(
      JSON.stringify({ BUTTERBASE_API_KEY: 'src-value' }),
      process.env.AUTH_ENCRYPTION_KEY!,
    );
    await runtimeDb.query(
      `INSERT INTO app_functions (id, app_id, name, code, encrypted_env_vars, deployed_by)
       VALUES (gen_random_uuid(), $1, 'lone-fn', '/* code */', $2, $3)`,
      [srcId, enc, ownerId],
    );

    // Deliberately omit controlPool + destAppOwnerId — the pre-existing
    // internal-mint branch would throw here; the preMintedSharedKey branch
    // must NOT.
    await expect(
      replayFunctions(runtimeDb, runtimeDb, srcId, destId, ownerId, noopLogger, {
        preMintedSharedKey: 'bb_sk_precondition_test',
      }),
    ).resolves.toBeDefined();

    await runtimeDb.query(`DELETE FROM app_functions WHERE app_id IN ($1, $2)`, [srcId, destId]);
    await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
    // platform_users → organizations order: FK is user.personal_organization_id
    // → orgs.id, so users must go first.
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
    await controlDb.query(`DELETE FROM organizations WHERE owner_id = $1`, [ownerId]);
  });
});
