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
      `INSERT INTO apps (id, name, owner_id, ai_config)
       VALUES ($1, 'usage-log-test', $2, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [appId, '00000000-0000-0000-0000-000000000001']
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

  it('accepts null appId and inserts NULL into app_id', async () => {
    await writeAiUsageRow(pool, {
      appId: null,
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
    });
    const r = await pool.query(
      `SELECT app_id FROM ai_usage_logs ORDER BY created_at DESC LIMIT 1`,
    );
    expect(r.rows[0].app_id).toBeNull();
  });
});
