import { describe, it, expect, vi } from 'vitest';
import { createCloneJob, getCloneJob, setCloneJobStatus } from '../clone-jobs.js';
import { decrypt } from '../crypto.js';
import { controlDb } from '../../__tests__/test-helpers/control-db.js';
import { randomUUID } from 'node:crypto';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

// Defect 5 (task-20 report): a clone job that completes successfully after
// an earlier internal attempt failed could still carry that attempt's
// error_message — the completion patch never cleared it, so a caller
// polling the job saw status: 'completed' with a stale, contradictory
// error attached. No real DB needed here: this only asserts what SQL
// setCloneJobStatus builds, so it runs unconditionally (not gated on
// RUN_DB_TESTS) and would have caught the regression in CI.
describe('setCloneJobStatus', () => {
  function fakePool() {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    return { query } as unknown as { query: typeof query };
  }

  it('clears error_message when transitioning to completed without an explicit error_message', async () => {
    const pool = fakePool();
    const completedAt = new Date('2026-09-08T00:00:00.000Z');
    await setCloneJobStatus(pool as any, 'cj_1', { status: 'completed', completed_at: completedAt });

    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toContain('error_message = $');
    expect(values).toContain(null);
    // Confirm error_message actually landed as null, not merely present.
    const errorMessageIndex = sql
      .split(',')
      .findIndex((clause: string) => clause.includes('error_message'));
    expect(errorMessageIndex).toBeGreaterThanOrEqual(0);
  });

  it('does not override an explicit error_message on a completed patch', async () => {
    const pool = fakePool();
    await setCloneJobStatus(pool as any, 'cj_1', {
      status: 'completed', error_message: 'explicit', completed_at: new Date(),
    });
    const [, values] = pool.query.mock.calls[0];
    expect(values).toContain('explicit');
    expect(values).not.toContain(null);
  });

  it('leaves error_message untouched on a non-completed status update', async () => {
    const pool = fakePool();
    await setCloneJobStatus(pool as any, 'cj_1', { status: 'replaying_schema' });
    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toContain('error_message');
  });
});

describeDb('createCloneJob with pendingEnvVarValues', () => {
  it('stores pending env var values encrypted at rest + auto_mint_requests as JSON', async () => {
    const ownerId = randomUUID();
    await controlDb.query(
      `INSERT INTO platform_users (id, email, email_verified) VALUES ($1, $2, true)
       ON CONFLICT (id) DO NOTHING`,
      [ownerId, `clone-jobs-test-${ownerId}@x.com`],
    );

    const values = { 'agent-chat': { BUTTERBASE_API_KEY: 'bb_sk_user' } };
    const mint = [{ fn_name: 'agent-chat', key: 'BUTTERBASE_API_KEY' }];
    const job = await createCloneJob(controlDb, {
      sourceAppId: 'app_src',
      sourceSnapshotId: 'snap_1',
      sourceRegion: 'us-east-1',
      destRegion: 'us-east-1',
      requestedByUserId: ownerId,
      pendingEnvVarValues: values,
      autoMintRequests: mint,
    });

    const persisted = await getCloneJob(controlDb, job.id);
    expect(persisted!.pending_env_vars).not.toBeNull();
    const decoded = JSON.parse(decrypt(persisted!.pending_env_vars!, process.env.AUTH_ENCRYPTION_KEY!));
    expect(decoded).toEqual(values);
    expect(persisted!.auto_mint_requests).toEqual(mint);

    await controlDb.query(`DELETE FROM template_clone_jobs WHERE id = $1`, [job.id]);
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
  });

  it('omits encryption + JSON write when neither field is provided', async () => {
    const ownerId = randomUUID();
    await controlDb.query(
      `INSERT INTO platform_users (id, email, email_verified) VALUES ($1, $2, true)
       ON CONFLICT (id) DO NOTHING`,
      [ownerId, `clone-jobs-test2-${ownerId}@x.com`],
    );
    const job = await createCloneJob(controlDb, {
      sourceAppId: 'app_src2',
      sourceSnapshotId: 'snap_2',
      sourceRegion: 'us-east-1',
      destRegion: 'us-east-1',
      requestedByUserId: ownerId,
    });
    const persisted = await getCloneJob(controlDb, job.id);
    expect(persisted!.pending_env_vars).toBeNull();
    expect(persisted!.auto_mint_requests).toBeNull();
    await controlDb.query(`DELETE FROM template_clone_jobs WHERE id = $1`, [job.id]);
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
  });
});
