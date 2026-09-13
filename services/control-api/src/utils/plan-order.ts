/**
 * Display order for the pricing table: cheapest first, "talk to us" last.
 *
 * This cannot be done in SQL alone. `price_monthly_cents` stores -1 to mean
 * "Custom" rather than a real price, so `ORDER BY price_monthly_cents ASC`
 * sorts Enterprise ahead of the free tier — the exact opposite of how a
 * pricing table is read. Sorting here keeps the sentinel's meaning in one
 * place instead of spreading it across every caller's ORDER BY.
 */

const CUSTOM_PRICE = -1;

type PricedRow = { price_monthly_cents: number };

export function sortPlansForDisplay<T extends PricedRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const aCustom = a.price_monthly_cents === CUSTOM_PRICE;
    const bCustom = b.price_monthly_cents === CUSTOM_PRICE;

    // Custom-priced plans go last. Two of them keep the order they arrived in
    // — there is no price to rank them by, so the caller's ORDER BY decides.
    if (aCustom || bCustom) return Number(aCustom) - Number(bCustom);

    return a.price_monthly_cents - b.price_monthly_cents;
  });
}
