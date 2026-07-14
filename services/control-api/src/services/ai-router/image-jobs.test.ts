import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { insertImageJob, getImageJob, markImageJobInProgress, markImageJobTerminal } from './image-jobs.js';

const RUNTIME_URL = process.env.NEON_RUNTIME_PRIMARY_URL
  ?? process.env.RUNTIME_DB_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_runtime';
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

describeDb('image-jobs DB helpers', () => {
  let pool: pg.Pool;
  const appId = `app_image_jobs_${Date.now()}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: RUNTIME_URL });
    await pool.query(
      `INSERT INTO apps (id, name, owner_id, db_name, ai_config)
       VALUES ($1, 'image-jobs-test', $2, $1, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [appId, '00000000-0000-0000-0000-000000000001'],
    );
  });

  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    await pool.query('DELETE FROM ai_image_jobs WHERE app_id = $1', [appId]);
  });

  function makeArgs(overrides?: Partial<Parameters<typeof insertImageJob>[1]>): Parameters<typeof insertImageJob>[1] {
    return {
      appId,
      userId: '00000000-0000-0000-0000-000000000002',
      endUserSub: null,
      model: 'openai/gpt-image-1',
      requestJson: { prompt: 'a cat flying' },
      upstreamRouter: 'openai',
      upstreamJobId: 'upstream-job-abc',
      upstreamPollingUrl: 'https://example.com/poll/abc',
      leaseId: crypto.randomUUID(),
      estimatedCostUsd: 0.5,
      markupPct: 20,
      ...overrides,
    };
  }

  it('insertImageJob + getImageJob round-trip', async () => {
    const id = await insertImageJob(pool, makeArgs());
    const row = await getImageJob(pool, id);

    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.status).toBe('pending');
    expect(row!.upstream_job_id).toBe('upstream-job-abc');
    expect(row!.settled_at).toBeNull();
    expect(row!.unsigned_urls).toBeNull();
    expect(row!.content_type).toBeNull();
    expect(row!.provider_cost_usd).toBeNull();
  });

  it('getImageJob returns null on missing id', async () => {
    const row = await getImageJob(pool, crypto.randomUUID());
    expect(row).toBeNull();
  });

  it('markImageJobInProgress is idempotent + status-gated', async () => {
    const id = await insertImageJob(pool, makeArgs());

    await markImageJobInProgress(pool, id);
    const afterFirst = await getImageJob(pool, id);
    expect(afterFirst!.status).toBe('in_progress');

    // Job is no longer 'pending', so second call should be a no-op
    await markImageJobInProgress(pool, id);
    const afterSecond = await getImageJob(pool, id);
    expect(afterSecond!.status).toBe('in_progress');
  });

  it('markImageJobTerminal first-call vs second-call', async () => {
    const id = await insertImageJob(pool, makeArgs());

    const first = await markImageJobTerminal(pool, id, {
      status: 'completed',
      unsignedUrls: ['https://x'],
      contentType: 'image/png',
      providerCostUsd: 0.25,
      chargedCreditsUsd: 0.30,
    });
    expect(first.firstTerminal).toBe(true);

    const row = await getImageJob(pool, id);
    expect(row!.status).toBe('completed');
    expect(row!.settled_at).not.toBeNull();
    expect(row!.unsigned_urls).toEqual(['https://x']);
    expect(row!.content_type).toBe('image/png');
    expect(parseFloat(row!.provider_cost_usd!)).toBeCloseTo(0.25, 6);
    expect(parseFloat(row!.charged_credits_usd!)).toBeCloseTo(0.30, 6);

    // Second call: settled_at is already set, should be no-op
    const second = await markImageJobTerminal(pool, id, {
      status: 'completed',
      unsignedUrls: ['https://x'],
      contentType: 'image/png',
      providerCostUsd: 0.25,
      chargedCreditsUsd: 0.30,
    });
    expect(second.firstTerminal).toBe(false);
  });

  it('markImageJobTerminal with status="failed" + error message', async () => {
    const id = await insertImageJob(pool, makeArgs());

    const result = await markImageJobTerminal(pool, id, {
      status: 'failed',
      error: 'rate exceeded',
    });
    expect(result.firstTerminal).toBe(true);

    const row = await getImageJob(pool, id);
    expect(row!.status).toBe('failed');
    expect(row!.error).toBe('rate exceeded');
    expect(row!.unsigned_urls).toBeNull();
    expect(row!.content_type).toBeNull();
    expect(row!.provider_cost_usd).toBeNull();
  });
});
