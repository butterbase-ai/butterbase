import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveMarkupPct, __clearSpecialPricingCache } from './special-pricing.js';
import { config } from '../../config.js';

function poolMock(handlers: (sql: string, params?: unknown[]) => { rows: any[] } | null) {
  return {
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      const r = handlers(sql, params);
      if (r === null) throw new Error('boom');
      return r;
    }),
  } as any;
}

const GLOBAL = config.aiRouter.markupPct;

beforeEach(() => __clearSpecialPricingCache());

describe('resolveMarkupPct', () => {
  it('returns global for null org without querying', async () => {
    const pool = poolMock(() => ({ rows: [] }));
    const r = await resolveMarkupPct(pool, null, 'anthropic/claude-haiku-4.5');
    expect(r).toEqual({ pct: GLOBAL, source: 'global' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns global for a non-special org', async () => {
    const pool = poolMock((sql) =>
      sql.includes('FROM organizations') ? { rows: [{ special_pricing: false }] } : { rows: [] });
    const r = await resolveMarkupPct(pool, 'org-1', 'anthropic/claude-haiku-4.5');
    expect(r).toEqual({ pct: GLOBAL, source: 'global' });
  });

  it('returns the book pct for special org + model in book', async () => {
    const pool = poolMock((sql) => {
      if (sql.includes('FROM organizations')) return { rows: [{ special_pricing: true }] };
      if (sql.includes('FROM special_model_markups')) {
        return { rows: [{ canonical_model_id: 'anthropic/claude-haiku-4.5', markup_pct: '12.500' }] };
      }
      return { rows: [] };
    });
    const r = await resolveMarkupPct(pool, 'org-1', 'anthropic/claude-haiku-4.5');
    expect(r).toEqual({ pct: 12.5, source: 'special' });
  });

  it('returns global for special org + model NOT in book', async () => {
    const pool = poolMock((sql) => {
      if (sql.includes('FROM organizations')) return { rows: [{ special_pricing: true }] };
      if (sql.includes('FROM special_model_markups')) return { rows: [] };
      return { rows: [] };
    });
    const r = await resolveMarkupPct(pool, 'org-1', 'openai/gpt-5.5');
    expect(r).toEqual({ pct: GLOBAL, source: 'global' });
  });

  it('degrades to global on DB error', async () => {
    const pool = poolMock(() => null);
    const r = await resolveMarkupPct(pool, 'org-1', 'anthropic/claude-haiku-4.5');
    expect(r).toEqual({ pct: GLOBAL, source: 'global_degraded' });
  });

  it('caches org flag and book within TTL (one query each)', async () => {
    const pool = poolMock((sql) => {
      if (sql.includes('FROM organizations')) return { rows: [{ special_pricing: true }] };
      if (sql.includes('FROM special_model_markups')) {
        return { rows: [{ canonical_model_id: 'm/a', markup_pct: '5' }] };
      }
      return { rows: [] };
    });
    await resolveMarkupPct(pool, 'org-1', 'm/a');
    await resolveMarkupPct(pool, 'org-1', 'm/a');
    await resolveMarkupPct(pool, 'org-1', 'm/b');
    expect(pool.query).toHaveBeenCalledTimes(2); // 1 org + 1 book
  });

  it('clamps out-of-range book values into [0, 200]', async () => {
    const pool = poolMock((sql) => {
      if (sql.includes('FROM organizations')) return { rows: [{ special_pricing: true }] };
      if (sql.includes('FROM special_model_markups')) {
        return { rows: [{ canonical_model_id: 'm/a', markup_pct: '999' }] };
      }
      return { rows: [] };
    });
    const r = await resolveMarkupPct(pool, 'org-1', 'm/a');
    expect(r.pct).toBe(200);
  });
});
