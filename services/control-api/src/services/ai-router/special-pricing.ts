import type pg from 'pg';
import { config } from '../../config.js';

export type MarkupSource = 'special' | 'global' | 'global_degraded';

const TTL_MS = 60_000;

let bookCache: { at: number; book: Map<string, number> } | null = null;
const orgFlagCache = new Map<string, { at: number; special: boolean }>();

/** Test hook: reset module-level caches between cases. */
export function __clearSpecialPricingCache(): void {
  bookCache = null;
  orgFlagCache.clear();
}

async function loadBook(controlDb: pg.Pool): Promise<Map<string, number>> {
  const now = Date.now();
  if (bookCache && now - bookCache.at < TTL_MS) return bookCache.book;
  const res = await controlDb.query(
    'SELECT canonical_model_id, markup_pct FROM special_model_markups',
  );
  const book = new Map<string, number>();
  for (const row of res.rows as Array<{ canonical_model_id: string; markup_pct: string }>) {
    const pct = parseFloat(row.markup_pct);
    if (Number.isFinite(pct)) book.set(row.canonical_model_id, pct);
  }
  bookCache = { at: now, book };
  return book;
}

async function isSpecialOrg(controlDb: pg.Pool, orgId: string): Promise<boolean> {
  const now = Date.now();
  const hit = orgFlagCache.get(orgId);
  if (hit && now - hit.at < TTL_MS) return hit.special;
  const res = await controlDb.query(
    'SELECT special_pricing FROM organizations WHERE id = $1',
    [orgId],
  );
  const special = res.rows.length > 0 && res.rows[0].special_pricing === true;
  orgFlagCache.set(orgId, { at: now, special });
  return special;
}

/**
 * Effective markup for one request: the shared special book's percentage when
 * the org is flagged special_pricing AND the canonical model has a book row;
 * otherwise the global AI_MARKUP_PERCENT. Never throws — a control-DB failure
 * degrades to the global markup so the request proceeds (source
 * 'global_degraded', logged for ops).
 */
export async function resolveMarkupPct(
  controlDb: pg.Pool,
  organizationId: string | null,
  model: string,
): Promise<{ pct: number; source: MarkupSource }> {
  const globalPct = config.aiRouter.markupPct;
  if (!organizationId) return { pct: globalPct, source: 'global' };
  try {
    if (!(await isSpecialOrg(controlDb, organizationId))) {
      return { pct: globalPct, source: 'global' };
    }
    const book = await loadBook(controlDb);
    const pct = book.get(model);
    if (pct === undefined) return { pct: globalPct, source: 'global' };
    return { pct: Math.max(0, Math.min(200, pct)), source: 'special' };
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn',
      type: 'ai_router.special_pricing_degraded',
      organization_id: organizationId,
      canonical_model: model,
      error: String(err),
    }));
    return { pct: globalPct, source: 'global_degraded' };
  }
}
