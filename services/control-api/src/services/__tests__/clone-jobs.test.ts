import { describe, it, expect } from 'vitest';
import { createCloneJob, getCloneJob } from '../clone-jobs.js';
import { decrypt } from '../crypto.js';
import { controlDb } from '../../__tests__/test-helpers/control-db.js';
import { randomUUID } from 'node:crypto';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

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
