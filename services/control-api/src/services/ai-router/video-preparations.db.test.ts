import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import * as p from './video-preparations.js';
import * as a from './reference-assets.js';

const dbUrl = process.env.PORTRAIT_TEST_DATABASE_URL;
const schema = `portrait_${randomUUID().replaceAll('-', '')}`;
let pool: pg.Pool;
const scope = { organizationId: 'org-test', appId: 'app-test', endUserSub: null, providerSlot: 'example', credentialNamespace: 'credential-v1' };
const original = { input_images: ['https://example.test/character.png'], reference_declarations: [{ path: '/input_images/0', kind: 'ai_generated_fictional_character' }] };
const job = () => p.createPreparation(pool, { ...scope, userId: 'owner', model: 'example/video', requestJson: original, deadline: new Date(Date.now() + 600_000), inputExpiresAt: new Date(Date.now() + 86_400_000) });
const claim = async (id: string) => (await p.claimPreparation(pool, id, 'worker', 60_000))!;
const attempt = async (id: string, fence: number) => (await p.createAttempt(pool, id, fence, { providerSlot: scope.providerSlot, credentialNamespace: scope.credentialNamespace, billingContext: { estimate: '0.12' } }))!;

describe.skipIf(!dbUrl)('video preparation persistence (real PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(dbUrl!);
    if (parsed.hostname !== '127.0.0.1' || parsed.port !== '15439' || parsed.pathname !== '/portrait_test') throw new Error('Requires isolated portrait_test database');
    pool = new pg.Pool({ connectionString: dbUrl, options: `-c search_path=${schema},public`, max: 8 });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(await readFile(new URL('../../../../../db/runtime-plane/056_ai_video_preparations.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); } });
  beforeEach(async () => { await pool.query('TRUNCATE ai_video_attempts, ai_video_preparations, ai_reference_assets, ai_reference_asset_groups CASCADE'); });

  it('persists a stable public job before submission and freezes originals and captured input identity', async () => {
    const row = await job(); expect(row.status).toBe('pending'); expect(row.request_json).toEqual(original);
    expect((await p.getPreparation(pool, row.id))?.id).toBe(row.id);
    expect((await pool.query('SELECT * FROM ai_video_attempts')).rowCount).toBe(0);
    const lease = await claim(row.id); const identity = { '/input_images/0': { sha256: 'a'.repeat(64), objectId: randomUUID() } };
    expect(await p.captureInputIdentity(pool, row.id, lease.fence, identity)).toBe(true);
    expect(await p.captureInputIdentity(pool, row.id, lease.fence, identity)).toBe(true);
    expect(await p.captureInputIdentity(pool, row.id, lease.fence, { '/input_images/0': { sha256: 'b'.repeat(64) } })).toBe(false);
    await expect(pool.query('UPDATE ai_video_preparations SET request_json = $2 WHERE id = $1', [row.id, {}])).rejects.toThrow(/immutable/);
  });
  it('has one claim winner across independent connections and fences stale workers', async () => {
    const row = await job(); const x = await pool.connect(); const y = await pool.connect();
    try {
      const claims = await Promise.all([p.claimPreparation(x, row.id, 'one', 60_000), p.claimPreparation(y, row.id, 'two', 60_000)]);
      expect(claims.filter(Boolean)).toHaveLength(1); const old = claims.find(Boolean)!;
      await pool.query("UPDATE ai_video_preparations SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [row.id]);
      const next = (await p.claimPreparation(y, row.id, 'new', 60_000))!;
      expect(Number(next.fence)).toBe(Number(old.fence) + 1);
      expect(await p.releasePreparation(x, row.id, old.fence)).toBe(false);
      expect(await p.captureInputIdentity(x, row.id, old.fence, {})).toBe(false);
      expect(await p.releasePreparation(y, row.id, next.fence)).toBe(true);
    } finally { x.release(); y.release(); }
  });
  it('freezes reservation and billing identity and never automatically reclaims uncertain paid POSTs', async () => {
    const row = await job(); const lease = await claim(row.id); const first = await attempt(row.id, lease.fence); const again = await attempt(row.id, lease.fence);
    expect(again.id).toBe(first.id); expect(again.reservation_id).toBe(first.reservation_id); expect(first.reservation_id).toMatch(/^[a-f0-9-]{36}$/);
    const submission = (await p.claimAttempt(pool, first.id, row.id, lease.fence, 'submitter', 60_000))!;
    expect(await p.markAttemptUncertain(pool, first.id, submission.fence, { code: 'transport_uncertain' })).toBe(true);
    expect(await p.claimAttempt(pool, first.id, row.id, lease.fence, 'another', 60_000)).toBeNull();
    expect(await p.markAttemptAccepted(pool, first.id, submission.fence, { jobId: 'upstream-1' })).toBe(true);
    expect((await p.getAttempt(pool, first.id))?.provider_handle).toEqual({ jobId: 'upstream-1' });
    await expect(pool.query('UPDATE ai_video_attempts SET billing_context = $2 WHERE id = $1', [first.id, {}])).rejects.toThrow(/immutable/);
  });
  it('requires durable settlement before the one atomic retry and never rewrites terminal outcomes', async () => {
    const row = await job(); const lease = await claim(row.id); const first = await attempt(row.id, lease.fence);
    const sub = (await p.claimAttempt(pool, first.id, row.id, lease.fence, 'submitter', 60_000))!;
    expect(await p.consumePreparationRetry(pool, row.id, lease.fence)).toBe(false);
    expect(await p.markAttemptTerminal(pool, first.id, sub.fence, { status: 'failed', error: 'eligible-input-rejection' })).toBe(true);
    expect(await p.markAttemptTerminal(pool, first.id, sub.fence, { status: 'completed', output: ['wrong'] })).toBe(false);
    expect(await p.consumePreparationRetry(pool, row.id, lease.fence)).toBe(false);
    const x = await pool.connect(); const y = await pool.connect();
    try {
      const ack = await Promise.all([p.acknowledgeAttemptSettlement(x, first.id, { receiptId: 'usage-1' }), p.acknowledgeAttemptSettlement(y, first.id, { receiptId: 'usage-race' })]);
      expect(ack.filter(Boolean)).toHaveLength(1);
      const retries = await Promise.all([p.consumePreparationRetry(x, row.id, lease.fence), p.consumePreparationRetry(y, row.id, lease.fence)]);
      expect(retries.filter(Boolean)).toHaveLength(1);
    } finally { x.release(); y.release(); }
    expect((await p.getAttempt(pool, first.id))?.settled_at).toBeInstanceOf(Date);
    expect((await p.getAttempt(pool, first.id))?.settlement_receipt).toBeTruthy();
    const second = await attempt(row.id, lease.fence); expect(second.attempt_number).toBe(2); expect(second.reservation_id).not.toBe(first.reservation_id);
    expect(await p.consumePreparationRetry(pool, row.id, lease.fence)).toBe(false);
  });
  it('requires output for success and fences terminal attempt writes after takeover', async () => {
    const row = await job(); const lease = await claim(row.id); const first = await attempt(row.id, lease.fence);
    const sub = (await p.claimAttempt(pool, first.id, row.id, lease.fence, 'submitter', 60_000))!;
    await expect(p.markAttemptTerminal(pool, first.id, sub.fence, { status: 'completed' })).rejects.toThrow(/output/);
    await p.markAttemptAccepted(pool, first.id, sub.fence, { jobId: 'accepted' });
    await pool.query("UPDATE ai_video_attempts SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [first.id]);
    const next = (await p.claimAttempt(pool, first.id, row.id, lease.fence, 'poller', 60_000))!;
    expect(await p.markAttemptTerminal(pool, first.id, sub.fence, { status: 'failed' })).toBe(false);
    expect(await p.markAttemptTerminal(pool, first.id, next.fence, { status: 'completed', output: ['video'] })).toBe(true);
  });
  it('deduplicates exact bytes in all ownership dimensions, including NULL versus empty subject', async () => {
    const group = await a.ensureReferenceGroup(pool, scope); expect((await a.ensureReferenceGroup(pool, scope)).id).toBe(group.id);
    const variants = [{ ...scope, organizationId: 'other' }, { ...scope, appId: 'other' }, { ...scope, endUserSub: 'user' }, { ...scope, endUserSub: '' }, { ...scope, providerSlot: 'other' }, { ...scope, credentialNamespace: 'v2' }];
    for (const v of variants) expect((await a.ensureReferenceGroup(pool, v)).id).not.toBe(group.id);
    const x = await pool.connect(); const y = await pool.connect();
    try {
      const rows = await Promise.all([a.ensureReferenceAsset(x, scope, 'a'.repeat(64)), a.ensureReferenceAsset(y, scope, 'a'.repeat(64))]);
      expect(rows[0].id).toBe(rows[1].id);
      expect((await a.ensureReferenceAsset(pool, scope, 'b'.repeat(64))).id).not.toBe(rows[0].id);
      expect((await a.ensureReferenceAsset(pool, variants[2], 'a'.repeat(64))).id).not.toBe(rows[0].id);
    } finally { x.release(); y.release(); }
  });
  it('claims assets once, preserves scope and retains durable tombstones for cleanup', async () => {
    const group = await a.ensureReferenceGroup(pool, scope); const gl = (await a.claimReferenceGroup(pool, scope, group.id, 'one', 60_000))!;
    expect(await a.persistReferenceGroup(pool, scope, group.id, gl.fence, { status: 'active', providerId: 'group-1' })).toBe(true);
    const asset = await a.ensureReferenceAsset(pool, scope, 'a'.repeat(64)); const x = await pool.connect(); const y = await pool.connect();
    try {
      const claims = await Promise.all([a.claimReferenceAsset(x, scope, asset.id, 'one', 60_000), a.claimReferenceAsset(y, scope, asset.id, 'two', 60_000)]);
      expect(claims.filter(Boolean)).toHaveLength(1); const old = claims.find(Boolean)!;
      expect(await a.persistReferenceAsset(pool, { ...scope, endUserSub: 'intruder' }, asset.id, old.fence, { status: 'active', providerId: 'asset-1' })).toBe(false);
      expect(await a.persistReferenceAsset(pool, scope, asset.id, old.fence, { status: 'uncertain' })).toBe(true);
      await pool.query("UPDATE ai_reference_assets SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [asset.id]);
      expect(await a.claimReferenceAsset(pool, scope, asset.id, 'retry', 60_000)).toBeNull();
      expect(await a.persistReferenceAsset(pool, scope, asset.id, old.fence, { status: 'active', providerId: 'asset-1' })).toBe(true);
    } finally { x.release(); y.release(); }
    const prep = await job(); expect(await p.hasBlockingPreparationWork(pool, scope.appId)).toBe(true);
    await a.tombstoneAppReferences(pool, scope.appId);
    expect((await a.getReferenceAsset(pool, scope, asset.id))?.cleanup_pending).toBe(true);
    expect(await a.claimReferenceAsset(pool, scope, asset.id, 'new', 60_000)).toBeNull();
    expect((await p.getPreparation(pool, prep.id))?.status).toBe('cancelled');
    const tombstones = await a.listReferenceCleanup(pool, 20); expect(tombstones.map(x => x.id)).toContain(asset.id); expect(tombstones.map(x => x.id)).toContain(group.id);
    expect(await a.acknowledgeReferenceCleanup(pool, 'asset', asset.id)).toBe(true);
    expect((await a.getReferenceAsset(pool, scope, asset.id))?.provider_id).toBeNull();
  });
  it('settles before finishing public jobs; archived jobs and mappings are hidden', async () => {
    const row = await job(); const lease = await claim(row.id); const first = await attempt(row.id, lease.fence); const sub = (await p.claimAttempt(pool, first.id, row.id, lease.fence, 'submitter', 60_000))!;
    await p.markAttemptTerminal(pool, first.id, sub.fence, { status: 'completed', output: ['video'] });
    expect(await p.finishPreparation(pool, row.id, lease.fence, { status: 'completed', output: ['video'] })).toBe(false);
    await p.acknowledgeAttemptSettlement(pool, first.id, { receiptId: 'receipt' });
    expect(await p.finishPreparation(pool, row.id, lease.fence, { status: 'completed', output: ['video'] })).toBe(true);
    expect(await p.hasBlockingPreparationWork(pool, scope.appId)).toBe(false);
    await pool.query('UPDATE ai_video_preparations SET archived_after_move = $2 WHERE id = $1', [row.id, randomUUID()]); expect(await p.getPreparation(pool, row.id)).toBeNull();
    const asset = await a.ensureReferenceAsset(pool, scope, 'a'.repeat(64));
    await pool.query('UPDATE ai_reference_assets SET archived_after_move = $2 WHERE id = $1', [asset.id, randomUUID()]); expect(await a.getReferenceAsset(pool, scope, asset.id)).toBeNull();
  });
  it('recovers uncertain/crashed submissions without granting another POST after deletion', async () => {
    const row = await job(); const lease = await claim(row.id); const first = await attempt(row.id, lease.fence);
    const sub = (await p.claimAttempt(pool, first.id, row.id, lease.fence, 'poster', 60_000))!;
    await pool.query("UPDATE ai_video_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [first.id]);
    await a.tombstoneAppReferences(pool, scope.appId);
    expect((await p.listAttemptRecovery(pool, 10)).map(x => x.id)).toContain(first.id);
    const recovered = (await p.claimAttemptRecovery(pool, first.id, 'reconciler', 60_000))!;
    expect(recovered.submission_state).toBe('uncertain');
    expect(recovered.fence).toBeGreaterThan(sub.fence);
    expect(await p.claimAttempt(pool, first.id, row.id, lease.fence, 'poster', 60_000)).toBeNull();
    expect(await p.markAttemptAccepted(pool, first.id, sub.fence, { jobId: 'stale' })).toBe(false);
    expect(await p.markAttemptAccepted(pool, first.id, recovered.fence, { jobId: 'reconciled' })).toBe(true);
    expect(await p.markAttemptTerminal(pool, first.id, recovered.fence, { status: 'failed' })).toBe(true);
    expect(await p.acknowledgeAttemptSettlement(pool, first.id, { receiptId: 'after-delete' })).toBe(true);
    expect((await p.getAttempt(pool, first.id))?.settlement_status).toBe('acknowledged');
  });
  it('claims expired preparations for terminalization while blocking all new paid work', async () => {
    const row = await p.createPreparation(pool, { ...scope, userId: 'owner', model: 'test', requestJson: original,
      deadline: new Date(Date.now()-1000), inputExpiresAt: new Date(Date.now()+60_000) });
    const lease = await claim(row.id); expect(lease).toBeTruthy();
    expect(await p.createAttempt(pool, row.id, lease.fence, { providerSlot: 'example', credentialNamespace: 'v1', billingContext: {} })).toBeNull();
    expect(await p.finishPreparation(pool, row.id, lease.fence, { status: 'expired' })).toBe(true);
  });
  it('cannot use archived/deleted mappings and rejects cross-scope group linkage', async () => {
    const group = await a.ensureReferenceGroup(pool, scope); const gl = (await a.claimReferenceGroup(pool, scope, group.id, 'g', 60_000))!;
    await a.persistReferenceGroup(pool, scope, group.id, gl.fence, { status: 'active', providerId: 'group' });
    const asset = await a.ensureReferenceAsset(pool, scope, 'a'.repeat(64)); const al = (await a.claimReferenceAsset(pool, scope, asset.id, 'a', 60_000))!;
    const other = await a.ensureReferenceGroup(pool, { ...scope, endUserSub: 'other' });
    expect(await a.attachReferenceAssetGroup(pool, scope, asset.id, al.fence, other.id)).toBe(false);
    expect(await a.attachReferenceAssetGroup(pool, scope, asset.id, al.fence, group.id)).toBe(true);
    await a.tombstoneAppReferences(pool, scope.appId);
    await expect(a.ensureReferenceAsset(pool, scope, 'a'.repeat(64))).rejects.toThrow(/unavailable/);
    expect(await a.acknowledgeReferenceCleanup(pool, 'asset', asset.id)).toBe(false); // uncertain POST still unresolved
    expect(await a.persistReferenceAsset(pool, scope, asset.id, al.fence, { status: 'active', providerId: 'late' })).toBe(true);
    expect(await a.acknowledgeReferenceCleanup(pool, 'group', group.id)).toBe(false);
    expect(await a.acknowledgeReferenceCleanup(pool, 'asset', asset.id)).toBe(true);
    expect(await a.acknowledgeReferenceCleanup(pool, 'group', group.id)).toBe(true);
  });

  it('serializes attempt creation and claim races with a stable deterministic reservation', async () => {
    const row = await job(); const lease = await claim(row.id); const x = await pool.connect(); const y = await pool.connect();
    const args = { providerSlot: scope.providerSlot, credentialNamespace: scope.credentialNamespace, billingContext: { estimate: '0.12' } };
    try {
      const rows = await Promise.all([p.createAttempt(x, row.id, lease.fence, args), p.createAttempt(y, row.id, lease.fence, args)]);
      expect(rows[0]?.id).toBe(rows[1]?.id); expect(rows[0]?.reservation_id).toBe(rows[1]?.reservation_id);
      const claims = await Promise.all([p.claimAttempt(x, rows[0]!.id, row.id, lease.fence, 'x', 60_000), p.claimAttempt(y, rows[0]!.id, row.id, lease.fence, 'y', 60_000)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const frozen = (await p.createAttempt(pool, row.id, lease.fence, { ...args, billingContext: { estimate: '999' } }))!;
      expect(frozen.billing_context).toEqual(args.billingContext);
      // Recreating the never-submitted row recovers its reservation identity.
      const id = rows[0]!.reservation_id; await pool.query('DELETE FROM ai_video_attempts WHERE id=$1', [rows[0]!.id]);
      expect((await p.createAttempt(pool, row.id, lease.fence, args))?.reservation_id).toBe(id);
    } finally { x.release(); y.release(); }
  });

  it('recovers cancelled pre-submit reservations without stealing active created attempts', async () => {
    const row = await job(); const lease = await claim(row.id); const first = await attempt(row.id, lease.fence);
    expect(await p.claimAttemptRecovery(pool, first.id, 'recovery', 60_000)).toBeNull();
    expect((await p.listAttemptRecovery(pool)).map(x => x.id)).not.toContain(first.id);
    await a.tombstoneAppReferences(pool, scope.appId);
    expect((await p.listAttemptRecovery(pool)).map(x => x.id)).toContain(first.id);
    const recovery = (await p.claimAttemptRecovery(pool, first.id, 'recovery', 60_000))!;
    expect(recovery.submission_state).toBe('uncertain');
    expect(recovery.diagnostic).toEqual({ recoveryMode: 'reservation_only' });
    expect(await p.markAttemptTerminal(pool, first.id, recovery.fence, { status: 'cancelled', error: 'not submitted' })).toBe(true);
    expect(await p.acknowledgeAttemptSettlement(pool, first.id, { reservationReleased: true })).toBe(true);
  });

});
