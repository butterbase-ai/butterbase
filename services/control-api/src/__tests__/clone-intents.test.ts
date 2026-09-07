import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function poolWith(rows: unknown[]) {
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length })) } as any;
}

beforeEach(() => vi.clearAllMocks());

describe('clone-intents', () => {
  it('encrypts env values on create and never returns them', async () => {
    const { createCloneIntent } = await import('../services/clone-intents.js');
    const pool = poolWith([{ id: 'ci_1', expires_at: new Date(Date.now() + 3600_000) }]);
    const out = await createCloneIntent(pool, {
      sourceAppId: 'app_src',
      envVarValues: { fn: { SECRET: 'hunter2' } },
    });
    expect(out.id).toBeTruthy();
    expect(JSON.stringify(out)).not.toContain('hunter2');
    const storedParams = pool.query.mock.calls[0][1] as unknown[];
    expect(storedParams.some((p) => typeof p === 'string' && p.includes('hunter2'))).toBe(false);
  });

  it('round-trips env values through load', async () => {
    const { createCloneIntent, loadRedeemableIntent } = await import('../services/clone-intents.js');
    const capture = { value: null as string | null };
    const writePool = {
      query: vi.fn(async (_sql: string, params: unknown[]) => {
        capture.value = params[4] as string;
        return { rows: [{ id: 'ci_1', expires_at: new Date(Date.now() + 3600_000) }], rowCount: 1 };
      }),
    } as any;
    await createCloneIntent(writePool, {
      sourceAppId: 'app_src', envVarValues: { fn: { SECRET: 'hunter2' } },
    });

    const readPool = poolWith([{
      id: 'ci_1', source_app_id: 'app_src', dest_app_name: null, dest_region: null,
      encrypted_env_values: capture.value, auto_mint_requests: null,
      created_at: new Date(), expires_at: new Date(Date.now() + 3600_000),
      redeemed_at: null, redeemed_by_user_id: null, resulting_job_id: null,
    }]);
    const res = await loadRedeemableIntent(readPool, 'ci_1');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.envVarValues).toEqual({ fn: { SECRET: 'hunter2' } });
  });

  it('reports expired intents', async () => {
    const { loadRedeemableIntent } = await import('../services/clone-intents.js');
    const pool = poolWith([{
      id: 'ci_old', source_app_id: 'app_src', dest_app_name: null, dest_region: null,
      encrypted_env_values: null, auto_mint_requests: null,
      created_at: new Date(Date.now() - 7200_000), expires_at: new Date(Date.now() - 3600_000),
      redeemed_at: null, redeemed_by_user_id: null, resulting_job_id: null,
    }]);
    const res = await loadRedeemableIntent(pool, 'ci_old');
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  it('reports already-redeemed intents with their job id', async () => {
    const { loadRedeemableIntent } = await import('../services/clone-intents.js');
    const pool = poolWith([{
      id: 'ci_done', source_app_id: 'app_src', dest_app_name: null, dest_region: null,
      encrypted_env_values: null, auto_mint_requests: null,
      created_at: new Date(), expires_at: new Date(Date.now() + 3600_000),
      redeemed_at: new Date(), redeemed_by_user_id: 'usr_1', resulting_job_id: 'cj_9',
    }]);
    const res = await loadRedeemableIntent(pool, 'ci_done');
    expect(res).toEqual({ ok: false, reason: 'already_redeemed', jobId: 'cj_9' });
  });

  it('NULLs encrypted values when marking redeemed', async () => {
    const { markIntentRedeemed } = await import('../services/clone-intents.js');
    const pool = poolWith([]);
    await markIntentRedeemed(pool, { id: 'ci_1', userId: 'usr_1', jobId: 'cj_1' });
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/encrypted_env_values\s*=\s*NULL/i);
  });
});
