import { describe, it, expect } from 'vitest';
import { sortPlansForDisplay } from './plan-order.js';

/**
 * The pricing table reads left-to-right as "cheapest first, talk-to-us last".
 * A plain `ORDER BY price_monthly_cents ASC` cannot express that, because
 * Enterprise stores -1 as its "Custom" sentinel and so sorts ahead of the free
 * tier. These tests pin the display order that ordering is meant to produce.
 */
describe('sortPlansForDisplay', () => {
  const playground = { id: 'playground', price_monthly_cents: 0 };
  const launch = { id: 'launch', price_monthly_cents: 1900 };
  const certified = { id: 'certified', price_monthly_cents: 9000 };
  const enterprise = { id: 'enterprise', price_monthly_cents: -1 };

  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

  it('puts the free tier first and the custom-priced tier last', () => {
    // The order `ORDER BY price_monthly_cents ASC` actually hands us.
    const fromDb = [enterprise, playground, launch, certified];

    expect(ids(sortPlansForDisplay(fromDb))).toEqual([
      'playground',
      'launch',
      'certified',
      'enterprise',
    ]);
  });

  it('orders the priced tiers cheapest-first regardless of input order', () => {
    expect(ids(sortPlansForDisplay([certified, launch, playground]))).toEqual([
      'playground',
      'launch',
      'certified',
    ]);
  });

  it('keeps every custom-priced plan at the end, in their original order', () => {
    const enterprisePlus = { id: 'enterprise_plus', price_monthly_cents: -1 };

    expect(ids(sortPlansForDisplay([enterprise, enterprisePlus, launch]))).toEqual([
      'launch',
      'enterprise',
      'enterprise_plus',
    ]);
  });

  it('does not mutate the array it was given', () => {
    const fromDb = [enterprise, playground];
    sortPlansForDisplay(fromDb);

    expect(ids(fromDb)).toEqual(['enterprise', 'playground']);
  });

  it('handles an empty plan list', () => {
    expect(sortPlansForDisplay([])).toEqual([]);
  });
});
