import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreparedOutputTestDb } from '../../../test/fixtures/prepared-output-db.js';
import * as outputs from './video-preparation-outputs.js';
import * as preparations from './video-preparations.js';
import { createVideoPreparationDriver } from './video-preparation.js';
import type { VideoPreparationHooks } from './video-preparation-hooks.js';
import { buildPublicPreparationResponse } from '../../routes/ai-videos.js';

let fixture: Awaited<ReturnType<typeof createPreparedOutputTestDb>>;
let scope: Awaited<ReturnType<typeof fixture.seed>>;
const measured = { sizeBytes: 128, contentType: 'video/mp4', sha256: 'a'.repeat(64) };

describe.skipIf(!process.env.VIDEO_OUTPUT_TEST_DATABASE_URL)('stored video lifecycle driver (isolated PostgreSQL)', () => {
  beforeAll(async () => { fixture = await createPreparedOutputTestDb(); });
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => { await fixture.reset(); scope = await fixture.seed(); });
  async function storedIds() {
    const row = (await outputs.ensurePreparedOutputs(fixture.pool, { attemptId: scope.attempt.id, attemptFence: 1, bucket: 'test-bucket', count: 1, providerCostUsd: 0.2 }))![0];
    const copy = (await outputs.claimPreparedOutput(fixture.pool, row.id, { attemptFence: 1, worker: 'copy' }))!;
    await outputs.recordPreparedOutputMeasurement(fixture.pool, row.id, copy.fence, measured);
    await fixture.pool.query('UPDATE ai_video_preparation_outputs SET capacity_reserved=true WHERE id=$1', [row.id]);
    await outputs.markPreparedOutputCopied(fixture.pool, row.id, copy.fence);
    return (await outputs.commitPreparedOutputMetadata(fixture.pool, { attemptId: scope.attempt.id, attemptFence: 1 }))!;
  }
  function driver(outcome: preparations.TerminalOutcome) {
    const hooks: VideoPreparationHooks = {
      quote: async () => null, authorize: async () => 'allowed',
      prepareReference: vi.fn(async () => { throw new Error('Unexpected reference registration'); }),
      reserve: vi.fn(async () => ({ ok: true as const })),
      submit: vi.fn(async () => { throw new Error('Unexpected generation POST'); }),
      poll: vi.fn(async () => ({ status: 'terminal' as const, outcome })),
      reconcile: vi.fn(async () => ({ status: 'pending' as const })),
      readReceipt: async () => null,
      settle: vi.fn(async (_ctx, attempt) => ({ status: 'settled', reservationId: attempt.reservation_id, chargedUsd: attempt.terminal_outcome?.status === 'completed' ? 0.24 : 0 })),
      writeUsage: vi.fn(async () => {}), content: async () => { throw new Error('Not used'); },
    };
    return { hooks, driver: createVideoPreparationDriver({ runtimePool: fixture.pool, platformPool: fixture.pool, region: 'us-east-1', hooks, retryMs: 1 }) };
  }
  async function recover(d: ReturnType<typeof driver>['driver']) {
    await fixture.pool.query("UPDATE ai_video_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [scope.attempt.id]);
    await d.recoverAttempt((await preparations.getAttempt(fixture.pool, scope.attempt.id))!);
  }
  async function advance(d: ReturnType<typeof driver>['driver']) {
    await fixture.pool.query("UPDATE ai_video_preparations SET next_action_at=now()-interval '1 second' WHERE id=$1", [scope.job.id]);
    await d.advanceVideoPreparation(scope.job.id);
  }
  it('keeps stored output identities through recovery, one receipt, publication and public content URLs', async () => {
    const ids = await storedIds();
    const outcome = { status: 'completed' as const, outputObjectIds: ids, providerCostUsd: 0.2 };
    const work = driver(outcome);
    await recover(work.driver);
    expect((await preparations.getAttempt(fixture.pool, scope.attempt.id))?.terminal_outcome).toEqual(outcome);
    await advance(work.driver);
    expect((await fixture.pool.query('SELECT published_at FROM storage_objects')).rows[0].published_at).toBeNull();
    await advance(work.driver);
    const job = (await preparations.getPreparation(fixture.pool, scope.job.id))!;
    expect(job.status).toBe('completed');
    expect((await fixture.pool.query('SELECT published_at FROM storage_objects')).rows[0].published_at).toBeInstanceOf(Date);
    const attempts = await preparations.listPreparationAttempts(fixture.pool, job.id);
    const response = buildPublicPreparationResponse('https://api.example', scope.app, job, attempts);
    expect(response.content_urls).toEqual([`https://api.example/v1/${scope.app}/videos/completions/${job.id}/content?index=0`]);
    expect(response.charged_credits_usd).toBe(0.24);
    expect(JSON.stringify(response)).not.toContain(ids[0]);
    await advance(work.driver);
    expect(work.hooks.settle).toHaveBeenCalledTimes(1); expect(work.hooks.writeUsage).toHaveBeenCalledTimes(1);
    expect(work.hooks.submit).not.toHaveBeenCalled(); expect(work.hooks.prepareReference).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'completed', outputObjectIds: ['not-an-object-id'], providerCostUsd: 0.2 },
    { status: 'completed', outputObjectIds: [], providerCostUsd: 0.2 },
    { status: 'completed', outputObjectIds: ['00000000-0000-4000-8000-000000000001'], output: ['https://media.example/video.mp4'], providerCostUsd: 0.2 },
  ] as preparations.TerminalOutcome[])('rejects invalid or mixed output contracts before success settlement: %j', async outcome => {
    const work = driver(outcome); await recover(work.driver); await advance(work.driver);
    const attempt = (await preparations.getAttempt(fixture.pool, scope.attempt.id))!;
    expect(attempt.terminal_outcome).toEqual({ status: 'failed', error: 'invalid_provider_output', providerStatus: 'completed', providerCostUsd: 0.2 });
    expect(attempt.settlement_receipt?.chargedUsd).toBe(0);
    expect(work.hooks.submit).not.toHaveBeenCalled();
  });
});
