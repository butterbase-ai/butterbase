process.env.AUTH_ENCRYPTION_KEY ??= '00'.repeat(32);
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// Mock CF's Workers for Platforms API so bundleAndDeploy stays in-process.
// The auto-mint write happens BEFORE bundleAndDeploy inside
// replayDurableObjectsForClone, so a successful CF stub also lets us verify
// the READY status transition on the destination DO row.
vi.mock('../cloudflare-wfp.js', () => ({
  NS: 'bb-frontends',
  deployDoWorker: vi.fn().mockResolvedValue({ newTag: 'v-test-clone' }),
  deleteDoWorker: vi.fn().mockResolvedValue(undefined),
  getDoWorkerMigrationTag: vi.fn().mockResolvedValue(null),
}));

import { replayDurableObjectsForClone } from '../durable-objects.service.js';
import { decrypt, encrypt } from '../crypto.js';
import { runtimeDb, controlDb, seedUser } from '../../__tests__/test-helpers/control-db.js';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

// Single-region test topology: source and dest apps share one physical pool.
// Named separately to match call-site semantics in the brief's test cases.
const sourceRuntimePool = runtimeDb;
const destRuntimePool = runtimeDb;

// A minimally-valid DO class source — buildBundle re-extracts class_name via
// regex from `export class Name extends DurableObject`, so this string is not
// arbitrary. Matches the shape used by durable-objects.service.test.ts fixtures.
const DO_CODE = `
export class ChatRoom {
  constructor(state, env) {}
  async fetch(request) { return new Response('hi'); }
}
`;

async function seedSourceDo(
  srcId: string,
  doName: string,
  className: string,
  envKeys: Record<string, string> = {},
) {
  const codeSha = createHash('sha256').update(DO_CODE).digest('hex');
  await runtimeDb.query(
    `INSERT INTO app_durable_objects (app_id, name, class_name, code, code_sha, access_mode, status)
     VALUES ($1, $2, $3, $4, $5, 'authenticated', 'READY')`,
    [srcId, doName, className, DO_CODE, codeSha],
  );
  for (const [key, value] of Object.entries(envKeys)) {
    const enc = encrypt(value, process.env.AUTH_ENCRYPTION_KEY!);
    await runtimeDb.query(
      `INSERT INTO app_do_env_vars (app_id, key, encrypted_value) VALUES ($1, $2, $3)`,
      [srcId, key, enc],
    );
  }
}

async function cleanup(ownerId: string, srcId: string, destId: string) {
  await runtimeDb.query(`DELETE FROM app_do_env_vars WHERE app_id IN ($1, $2)`, [srcId, destId]);
  await runtimeDb.query(`DELETE FROM app_durable_objects WHERE app_id IN ($1, $2)`, [srcId, destId]);
  await runtimeDb.query(`DELETE FROM app_do_deploy_state WHERE app_id IN ($1, $2)`, [srcId, destId]);
  await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
  await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
  await controlDb.query(`DELETE FROM organizations WHERE owner_id = $1`, [ownerId]);
}

/**
 * Shared fixture for appOverrides tests: seeds an owner + source/dest app
 * pair and a single source DO ('chat'/ChatRoom) declaring the given DO env
 * keys (each with a placeholder value that the override path is expected to
 * replace on the dest). Both source and dest apps live in `runtimeDb`
 * (single-region test topology), mirroring every other fixture in this file.
 * Caller is responsible for calling `cleanup(destApp.owner_id, sourceApp.id,
 * destApp.id)` afterwards.
 */
async function setupCloneFixture(opts: { sourceDoEnvKeys: string[] }) {
  const { id: ownerId } = await seedUser(`do-mint-override-${Date.now()}-${Math.random().toString(36).slice(2)}@x.com`);
  const srcId = `app_do_ovr_src_${ownerId.slice(0, 8)}`;
  const destId = `app_do_ovr_dst_${ownerId.slice(0, 8)}`;
  for (const id of [srcId, destId]) {
    await runtimeDb.query(
      `INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1, $1, $2, $1)`,
      [id, ownerId],
    );
  }
  const envKeys = Object.fromEntries(opts.sourceDoEnvKeys.map((k) => [k, `placeholder-${k}`]));
  await seedSourceDo(srcId, 'chat', 'ChatRoom', envKeys);

  return {
    sourceApp: { id: srcId, owner_id: ownerId },
    destApp: { id: destId, owner_id: ownerId },
    doName: 'chat',
  };
}

describeDb('replayDurableObjectsForClone auto-mint into app_do_env_vars', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the shared minted key into every convention DO env slot on the dest', async () => {
    const { id: ownerId } = await seedUser(`do-mint-conv-${Date.now()}@x.com`);
    const srcId = `app_do_conv_src_${ownerId.slice(0, 8)}`;
    const destId = `app_do_conv_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1, $1, $2, $1)`,
        [id, ownerId],
      );
    }
    await seedSourceDo(srcId, 'chat', 'ChatRoom', {
      BUTTERBASE_API_KEY: 'placeholder-in-source',
      BB_SUBSTRATE_KEY: 'placeholder-substrate',
    });

    const SHARED_KEY = 'bb_sk_orchestrator_minted_abc123';

    const result = await replayDurableObjectsForClone(
      runtimeDb, runtimeDb, controlDb, srcId, destId, ownerId,
      { sharedMintedKey: SHARED_KEY },
    );

    expect(result.cloned).toEqual(['chat']);
    expect(result.do_env_keys.sort()).toEqual(['BB_SUBSTRATE_KEY', 'BUTTERBASE_API_KEY']);
    expect(result.auto_minted_keys.sort()).toEqual(['BB_SUBSTRATE_KEY', 'BUTTERBASE_API_KEY']);

    const destRows = await runtimeDb.query<{ key: string; encrypted_value: string }>(
      `SELECT key, encrypted_value FROM app_do_env_vars WHERE app_id = $1 ORDER BY key`,
      [destId],
    );
    expect(destRows.rows.length).toBe(2);
    for (const row of destRows.rows) {
      expect(decrypt(row.encrypted_value, process.env.AUTH_ENCRYPTION_KEY!)).toBe(SHARED_KEY);
    }

    await cleanup(ownerId, srcId, destId);
  });

  it('does not touch app_do_env_vars when no shared key is provided (even with convention keys on source)', async () => {
    const { id: ownerId } = await seedUser(`do-mint-noshared-${Date.now()}@x.com`);
    const srcId = `app_do_no_src_${ownerId.slice(0, 8)}`;
    const destId = `app_do_no_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1, $1, $2, $1)`,
        [id, ownerId],
      );
    }
    await seedSourceDo(srcId, 'chat', 'ChatRoom', {
      BUTTERBASE_API_KEY: 'src-value',
    });

    // No sharedMintedKey → convention detection still fires (do_env_keys is
    // still populated for observability) but zero writes to the dest.
    const result = await replayDurableObjectsForClone(
      runtimeDb, runtimeDb, controlDb, srcId, destId, ownerId,
    );

    expect(result.cloned).toEqual(['chat']);
    expect(result.do_env_keys).toEqual(['BUTTERBASE_API_KEY']);
    expect(result.auto_minted_keys).toEqual([]);

    const destRows = await runtimeDb.query<{ key: string }>(
      `SELECT key FROM app_do_env_vars WHERE app_id = $1`,
      [destId],
    );
    expect(destRows.rows.length).toBe(0);

    await cleanup(ownerId, srcId, destId);
  });

  it('honors explicitAutoMintKeys alongside convention keys, deduping the write set', async () => {
    const { id: ownerId } = await seedUser(`do-mint-explicit-${Date.now()}@x.com`);
    const srcId = `app_do_exp_src_${ownerId.slice(0, 8)}`;
    const destId = `app_do_exp_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1, $1, $2, $1)`,
        [id, ownerId],
      );
    }
    // Source declares one convention key (BUTTERBASE_API_KEY) and one
    // non-convention key (CUSTOM_TOKEN). Caller explicitly requests
    // BUTTERBASE_API_KEY (redundant — should dedupe with convention path) plus
    // CUSTOM_TOKEN (not convention — only reachable via explicit opt-in).
    await seedSourceDo(srcId, 'chat', 'ChatRoom', {
      BUTTERBASE_API_KEY: 'placeholder',
      CUSTOM_TOKEN: 'placeholder-custom',
    });

    const SHARED_KEY = 'bb_sk_explicit_test_xyz';

    const result = await replayDurableObjectsForClone(
      runtimeDb, runtimeDb, controlDb, srcId, destId, ownerId,
      {
        sharedMintedKey: SHARED_KEY,
        explicitAutoMintKeys: ['BUTTERBASE_API_KEY', 'CUSTOM_TOKEN'],
      },
    );

    expect(result.auto_minted_keys.sort()).toEqual(['BUTTERBASE_API_KEY', 'CUSTOM_TOKEN']);

    const destRows = await runtimeDb.query<{ key: string; encrypted_value: string }>(
      `SELECT key, encrypted_value FROM app_do_env_vars WHERE app_id = $1 ORDER BY key`,
      [destId],
    );
    // Two rows written, one bb_sk_ value each. Nothing for BB_SUBSTRATE_KEY —
    // it wasn't in the source and wasn't in the explicit list.
    expect(destRows.rows.map((r) => r.key)).toEqual(['BUTTERBASE_API_KEY', 'CUSTOM_TOKEN']);
    for (const row of destRows.rows) {
      expect(decrypt(row.encrypted_value, process.env.AUTH_ENCRYPTION_KEY!)).toBe(SHARED_KEY);
    }

    await cleanup(ownerId, srcId, destId);
  });

  it('returns empty auto_minted_keys and does not write when source has no DOs', async () => {
    const { id: ownerId } = await seedUser(`do-mint-empty-${Date.now()}@x.com`);
    const srcId = `app_do_empty_src_${ownerId.slice(0, 8)}`;
    const destId = `app_do_empty_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1, $1, $2, $1)`,
        [id, ownerId],
      );
    }

    const result = await replayDurableObjectsForClone(
      runtimeDb, runtimeDb, controlDb, srcId, destId, ownerId,
      { sharedMintedKey: 'bb_sk_ignored' },
    );

    expect(result).toEqual({ cloned: [], do_env_keys: [], auto_minted_keys: [], override_filled_keys: [] });

    const destRows = await runtimeDb.query<{ key: string }>(
      `SELECT key FROM app_do_env_vars WHERE app_id = $1`,
      [destId],
    );
    expect(destRows.rows.length).toBe(0);

    await cleanup(ownerId, srcId, destId);
  });

  it('is idempotent — a second call with the same shared key upserts, not duplicates', async () => {
    const { id: ownerId } = await seedUser(`do-mint-idem-${Date.now()}@x.com`);
    const srcId = `app_do_idem_src_${ownerId.slice(0, 8)}`;
    const destId = `app_do_idem_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1, $1, $2, $1)`,
        [id, ownerId],
      );
    }
    await seedSourceDo(srcId, 'chat', 'ChatRoom', {
      BUTTERBASE_API_KEY: 'placeholder',
    });

    await replayDurableObjectsForClone(
      runtimeDb, runtimeDb, controlDb, srcId, destId, ownerId,
      { sharedMintedKey: 'bb_sk_first_mint' },
    );
    // Second call with a different value (simulating a re-run after a partial
    // failure that re-minted). The dest row must upsert, not insert-conflict.
    await replayDurableObjectsForClone(
      runtimeDb, runtimeDb, controlDb, srcId, destId, ownerId,
      { sharedMintedKey: 'bb_sk_second_mint' },
    );

    const destRows = await runtimeDb.query<{ key: string; encrypted_value: string }>(
      `SELECT key, encrypted_value FROM app_do_env_vars WHERE app_id = $1`,
      [destId],
    );
    expect(destRows.rows.length).toBe(1);
    expect(decrypt(destRows.rows[0].encrypted_value, process.env.AUTH_ENCRYPTION_KEY!))
      .toBe('bb_sk_second_mint');

    await cleanup(ownerId, srcId, destId);
  });

  it('layers appOverrides into declared DO env keys and writes the encrypted value', async () => {
    const { sourceApp, destApp } = await setupCloneFixture({
      // Fixture helper (already in this file) inserts a DO row on the source
      // + an app_do_env_vars row for 'CUSTOM_SECRET' whose value is a
      // placeholder that we expect the override to REPLACE on the dest.
      sourceDoEnvKeys: ['CUSTOM_SECRET'],
    });

    const result = await replayDurableObjectsForClone(
      sourceRuntimePool,
      destRuntimePool,
      controlDb,
      sourceApp.id,
      destApp.id,
      destApp.owner_id,
      { appOverrides: { CUSTOM_SECRET: 'deadbeef'.repeat(8) } },
    );

    expect(result.override_filled_keys).toContain('CUSTOM_SECRET');
    const row = await destRuntimePool.query<{ encrypted_value: string }>(
      `SELECT encrypted_value FROM app_do_env_vars WHERE app_id = $1 AND key = $2`,
      [destApp.id, 'CUSTOM_SECRET'],
    );
    const encKey = process.env.AUTH_ENCRYPTION_KEY!;
    expect(decrypt(row.rows[0].encrypted_value, encKey)).toEqual('deadbeef'.repeat(8));

    await cleanup(destApp.owner_id, sourceApp.id, destApp.id);
  });

  it('skips appOverride keys that the source DO does not declare', async () => {
    const { sourceApp, destApp } = await setupCloneFixture({ sourceDoEnvKeys: ['ONLY_THIS'] });
    const result = await replayDurableObjectsForClone(
      sourceRuntimePool,
      destRuntimePool,
      controlDb,
      sourceApp.id,
      destApp.id,
      destApp.owner_id,
      { appOverrides: { NOT_DECLARED: 'x'.repeat(64) } },
    );
    expect(result.override_filled_keys).toEqual([]);
    const row = await destRuntimePool.query(
      `SELECT 1 FROM app_do_env_vars WHERE app_id = $1 AND key = 'NOT_DECLARED'`,
      [destApp.id],
    );
    expect(row.rowCount).toBe(0);

    await cleanup(destApp.owner_id, sourceApp.id, destApp.id);
  });

  it('convention auto-mint wins over appOverrides for the same key', async () => {
    const { sourceApp, destApp } = await setupCloneFixture({
      sourceDoEnvKeys: ['BUTTERBASE_API_KEY'],
    });
    const result = await replayDurableObjectsForClone(
      sourceRuntimePool,
      destRuntimePool,
      controlDb,
      sourceApp.id,
      destApp.id,
      destApp.owner_id,
      {
        sharedMintedKey: 'bb_sk_from_mint',
        appOverrides: { BUTTERBASE_API_KEY: 'bb_sk_from_override' },
      },
    );
    expect(result.auto_minted_keys).toContain('BUTTERBASE_API_KEY');
    expect(result.override_filled_keys).not.toContain('BUTTERBASE_API_KEY');
    const row = await destRuntimePool.query<{ encrypted_value: string }>(
      `SELECT encrypted_value FROM app_do_env_vars WHERE app_id = $1 AND key = 'BUTTERBASE_API_KEY'`,
      [destApp.id],
    );
    expect(decrypt(row.rows[0].encrypted_value, process.env.AUTH_ENCRYPTION_KEY!)).toEqual('bb_sk_from_mint');

    await cleanup(destApp.owner_id, sourceApp.id, destApp.id);
  });
});
