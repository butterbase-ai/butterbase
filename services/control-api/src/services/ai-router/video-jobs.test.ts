import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { insertVideoJob, getVideoJob, markVideoJobInProgress, markVideoJobTerminal } from './video-jobs.js';

const RUNTIME_URL = process.env.NEON_RUNTIME_PRIMARY_URL
  ?? process.env.RUNTIME_DB_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_runtime';
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

describeDb('video-jobs DB helpers', () => {
  let pool: pg.Pool;
  const appId = `app_video_jobs_${Date.now()}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: RUNTIME_URL });
    await pool.query(
      `INSERT INTO apps (id, name, owner_id, db_name, ai_config)
       VALUES ($1, 'video-jobs-test', $2, $1, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [appId, '00000000-0000-0000-0000-000000000001'],
    );
  });

  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    await pool.query('DELETE FROM ai_video_jobs WHERE app_id = $1', [appId]);
  });

  function makeArgs(overrides?: Partial<Parameters<typeof insertVideoJob>[1]>): Parameters<typeof insertVideoJob>[1] {
    return {
      appId,
      userId: '00000000-0000-0000-0000-000000000002',
      model: 'kling/kling-v1',
      requestJson: { prompt: 'a cat flying' },
      upstreamRouter: 'kling',
      upstreamJobId: 'upstream-job-abc',
      upstreamPollingUrl: 'https://example.com/poll/abc',
      leaseId: crypto.randomUUID(),
      estimatedCostUsd: 0.5,
      markupPct: 20,
      ...overrides,
    };
  }

  it('insertVideoJob + getVideoJob round-trip', async () => {
    const id = await insertVideoJob(pool, makeArgs());
    const row = await getVideoJob(pool, id);

    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.status).toBe('pending');
    expect(row!.upstream_job_id).toBe('upstream-job-abc');
    expect(row!.settled_at).toBeNull();
    expect(row!.unsigned_urls).toBeNull();
    expect(row!.provider_cost_usd).toBeNull();
  });

  it('markVideoJobInProgress is idempotent + status-gated', async () => {
    const id = await insertVideoJob(pool, makeArgs());

    await markVideoJobInProgress(pool, id);
    const afterFirst = await getVideoJob(pool, id);
    expect(afterFirst!.status).toBe('in_progress');

    // Job is no longer 'pending', so second call should be a no-op
    await markVideoJobInProgress(pool, id);
    const afterSecond = await getVideoJob(pool, id);
    expect(afterSecond!.status).toBe('in_progress');
  });

  it('markVideoJobTerminal first-call vs second-call', async () => {
    const id = await insertVideoJob(pool, makeArgs());

    const first = await markVideoJobTerminal(pool, id, {
      status: 'completed',
      unsignedUrls: ['https://x'],
      providerCostUsd: 0.25,
      chargedCreditsUsd: 0.30,
    });
    expect(first.firstTerminal).toBe(true);

    const row = await getVideoJob(pool, id);
    expect(row!.status).toBe('completed');
    expect(row!.settled_at).not.toBeNull();
    expect(row!.unsigned_urls).toEqual(['https://x']);
    expect(parseFloat(row!.provider_cost_usd!)).toBeCloseTo(0.25, 6);
    expect(parseFloat(row!.charged_credits_usd!)).toBeCloseTo(0.30, 6);

    // Second call: settled_at is already set, should be no-op
    const second = await markVideoJobTerminal(pool, id, {
      status: 'completed',
      unsignedUrls: ['https://x'],
      providerCostUsd: 0.25,
      chargedCreditsUsd: 0.30,
    });
    expect(second.firstTerminal).toBe(false);
  });

  it('markVideoJobTerminal with status="failed" + error message', async () => {
    const id = await insertVideoJob(pool, makeArgs());

    const result = await markVideoJobTerminal(pool, id, {
      status: 'failed',
      error: 'rate exceeded',
    });
    expect(result.firstTerminal).toBe(true);

    const row = await getVideoJob(pool, id);
    expect(row!.status).toBe('failed');
    expect(row!.error).toBe('rate exceeded');
    expect(row!.unsigned_urls).toBeNull();
    expect(row!.provider_cost_usd).toBeNull();
  });
});
