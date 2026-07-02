import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { writeAiUsageRow, type AiUsageRow } from './usage-log.js';

const RUNTIME_URL = process.env.NEON_RUNTIME_PRIMARY_URL
  ?? process.env.RUNTIME_DB_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_runtime';
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

describeDb('writeAiUsageRow', () => {
  let pool: pg.Pool;
  const appId = `app_usage_log_${Date.now()}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: RUNTIME_URL });
    await pool.query(
      `INSERT INTO apps (id, name, owner_id, db_name, ai_config)
       VALUES ($1, 'usage-log-test', $2, $3, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [appId, '00000000-0000-0000-0000-000000000001', `db_${appId}`]
    );
  });
  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    await pool.query('DELETE FROM ai_usage_logs WHERE app_id = $1', [appId]);
  });

  it('writes a row with all new router columns populated', async () => {
    const row: AiUsageRow = {
      appId,
      userId: null,
      model: 'anthropic/claude-3-5-sonnet',
      router: 'provider-primary',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      providerCostUsd: 0.001,
      chargedCreditsUsd: 0.0012,
      markupPct: 20,
      fallbackChain: [],
      leaseId: null,
      keyType: 'platform',
      chargedToUser: true,
    };
    await writeAiUsageRow(pool, row);
    const got = await pool.query(
      `SELECT router, provider_cost_usd, charged_credits_usd, markup_pct, fallback_chain, cost_usd, provider
       FROM ai_usage_logs WHERE app_id = $1`,
      [appId]
    );
    expect(got.rows[0].router).toBe('provider-primary');
    expect(got.rows[0].provider).toBe('provider-primary');
    expect(parseFloat(got.rows[0].provider_cost_usd)).toBeCloseTo(0.001, 6);
    expect(parseFloat(got.rows[0].charged_credits_usd)).toBeCloseTo(0.0012, 6);
    expect(parseFloat(got.rows[0].cost_usd)).toBeCloseTo(0.0012, 6);
    expect(parseFloat(got.rows[0].markup_pct)).toBeCloseTo(20, 3);
    expect(got.rows[0].fallback_chain).toEqual([]);
  });

  it('stores fallback_chain when fallbacks happened', async () => {
    await writeAiUsageRow(pool, {
      appId, userId: null, model: 'm', router: 'openrouter',
      promptTokens: 1, completionTokens: 1, totalTokens: 2,
      providerCostUsd: 0.0001, chargedCreditsUsd: 0.00012, markupPct: 20,
      fallbackChain: ['provider-primary:rate_limit', 'provider-secondary:transport'],
      leaseId: null, keyType: 'platform', chargedToUser: true,
    });
    const got = await pool.query(`SELECT fallback_chain FROM ai_usage_logs WHERE app_id = $1`, [appId]);
    expect(got.rows[0].fallback_chain).toEqual(['provider-primary:rate_limit', 'provider-secondary:transport']);
  });

  it('throws when appId is null (fail-loud contract)', async () => {
    await expect(
      writeAiUsageRow(pool, {
        appId: null as any,
        userId: null,
        model: 'anthropic/claude-opus-4.7',
        router: 'openrouter',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        providerCostUsd: 0.0001,
        chargedCreditsUsd: 0.00012,
        markupPct: 20,
        fallbackChain: [],
        leaseId: null,
        keyType: 'platform',
        chargedToUser: true,
      })
    ).rejects.toThrow(/writeAiUsageRow: row missing appId/);
  });

  it('persists cache_read and cache_creation token counts', async () => {
    await writeAiUsageRow(pool, {
      appId,
      userId: null,
      model: 'anthropic/claude-sonnet-4-6',
      router: 'provider-primary',
      promptTokens: 1000,
      completionTokens: 200,
      totalTokens: 1200,
      providerCostUsd: 0.003,
      chargedCreditsUsd: 0.0036,
      markupPct: 20,
      fallbackChain: [],
      leaseId: null,
      keyType: 'platform',
      chargedToUser: true,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 100,
    });
    const got = await pool.query(
      `SELECT cache_read_input_tokens, cache_creation_input_tokens
       FROM ai_usage_logs WHERE app_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [appId]
    );
    expect(BigInt(got.rows[0].cache_read_input_tokens)).toBe(800n);
    expect(BigInt(got.rows[0].cache_creation_input_tokens)).toBe(100n);
  });

  it('defaults cache token counts to 0 when omitted', async () => {
    await writeAiUsageRow(pool, {
      appId,
      userId: null,
      model: 'openai/gpt-4o',
      router: 'provider-primary',
      promptTokens: 50,
      completionTokens: 20,
      totalTokens: 70,
      providerCostUsd: 0.0002,
      chargedCreditsUsd: 0.00024,
      markupPct: 20,
      fallbackChain: [],
      leaseId: null,
      keyType: 'platform',
      chargedToUser: true,
      // cacheReadInputTokens and cacheCreationInputTokens intentionally omitted
    });
    const got = await pool.query(
      `SELECT cache_read_input_tokens, cache_creation_input_tokens
       FROM ai_usage_logs WHERE app_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [appId]
    );
    expect(Number(got.rows[0].cache_read_input_tokens)).toBe(0);
    expect(Number(got.rows[0].cache_creation_input_tokens)).toBe(0);
  });
});
